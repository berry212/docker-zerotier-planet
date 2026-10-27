'use strict';

// Exercise the real deploy.sh against a filesystem-backed Docker CLI fixture.
// This checks update/rollback orchestration, not Docker container runtime behavior.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const fixture = `const storage = require('node-persist');
storage.initSync({dir: 'etc/storage'});
async function list(nwid) {
  return Promise.resolve({}).then(member_ids => {
    return Promise.all(Object.keys(member_ids).map(id => Promise.all([{}, storage.getItem(id)])));
      }).then(results => results.map(([member, name]) => {
        member.name = name || '';
        return member;
      }));
}
async function detail(nwid, memberid) {
  const name = await storage.getItem(memberid);
  const member = {}, peer = {};
  member.name = name || '';
  member.peer = peer;
}
async function rename(req, res) {
  if (req.method === 'POST') {
    if (req.body.auth) {
    } else if (req.body.name) {
      await storage.setItem(req.body.id, req.body.name);
    }
  } else { // GET
    res.end();
  }
}
async function remove(req, member) {
  let name = await storage.removeItem(member.id);
  name = await storage.getItem(member.id);
  member.name = name || '';
}
`;

const mockDocker = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = process.env.MOCK_CONTAINER;
let args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
const mapped = value => value.split('/app/').join(root + '/app/');
if (args[0] === 'inspect') { if (args.includes('--format')) console.log('true'); process.exit(0); }
if (args[0] === 'restart' || args[0] === 'start') process.exit(0);
if (args[0] === 'cp') {
  const destination = args[2].slice(args[2].indexOf(':') + 1);
  fs.cpSync(args[1], mapped(destination), {recursive: true}); process.exit(0);
}
if (args[0] === 'exec') {
  args = args.slice(2);
  if (args[0] === 'node' && args[1] === '-e') {
    const app = fs.readFileSync(root + '/app/ztncui/src/app.js', 'utf8');
    const installed = fs.existsSync(root + '/app/ztncui/src/nickname-sync/index.js');
    process.exit(process.env.MOCK_HEALTH_FAIL === '1' || !installed || !app.includes('nickname-sync:v1') ? 1 : 0);
  }
  const result = cp.spawnSync(args[0], args.slice(1).map(mapped), {stdio: 'inherit'});
  process.exit(result.status === null ? 1 : result.status);
}
console.error('Unexpected Docker fixture invocation:', args); process.exit(2);
`;

function run(options) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nickname-deploy-'));
  const root = path.join(temporary, 'container');
  const src = path.join(root, 'app/ztncui/src');
  fs.mkdirSync(path.join(src, 'controllers'), {recursive: true});
  fs.mkdirSync(path.join(src, 'views'));
  fs.mkdirSync(path.join(root, 'app/config'), {recursive: true});
  fs.mkdirSync(path.join(root, 'var/lib/zerotier-one'), {recursive: true});
  fs.writeFileSync(path.join(src, 'app.js'), "app.use('/', index);\n");
  fs.writeFileSync(path.join(src, '.env'), 'HTTP_PORT=3443\n');
  fs.writeFileSync(path.join(src, 'controllers/networkController.js'), options.unsupported ? '// incompatible\n' : fixture);
  fs.writeFileSync(path.join(src, 'views/network_detail.pug'), `block content
  if (members !== undefined)
    script.
        $('.text').on('change', function() {
          $.post(url, {'id': this.name, 'name': this.value});
        });
    each member in members
      td
              input.form-control.text(type='text' name=member.id value=member.name)
`);
  fs.writeFileSync(path.join(root, 'var/lib/zerotier-one/identity.secret'), 'existing-private-identity');
  fs.writeFileSync(path.join(root, 'app/config/ip_addr4'), '203.0.113.10');
  const bin = path.join(temporary, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), mockDocker, {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const log = path.join(temporary, 'docker.log');
  const result = spawnSync('bash', [path.join(repository, 'deploy.sh')], {cwd: temporary, encoding: 'utf8',
    env: Object.assign({}, process.env, {PATH: bin + ':' + process.env.PATH,
      MOCK_CONTAINER: root, MOCK_LOG: log, MOCK_HEALTH_FAIL: options.fail ? '1' : '0'})});
  return {temporary, root, src, log, result};
}

test('running deploy.sh automatically updates an existing service without pulling images or deleting data', () => {
  const state = run({});
  try {
    assert.equal(state.result.status, 0, state.result.stdout + state.result.stderr);
    assert.match(state.result.stdout, /昵称同步服务已更新/);
    assert.match(fs.readFileSync(path.join(state.src, 'app.js'), 'utf8'), /nickname-sync:v1/);
    assert.equal(fs.existsSync(path.join(state.src, 'nickname-sync/index.js')), true);
    assert.equal(fs.readFileSync(path.join(state.root, 'var/lib/zerotier-one/identity.secret'), 'utf8'), 'existing-private-identity');
    assert.equal(fs.readFileSync(path.join(state.root, 'app/config/ip_addr4'), 'utf8'), '203.0.113.10');
    const calls = fs.readFileSync(state.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.some(call => ['pull', 'rm', 'run'].includes(call[0])), false);
    assert.equal(calls.filter(call => call[0] === 'restart').length, 1);
    assert.equal(fs.readdirSync(path.join(state.root, 'app/config/nickname-sync-backups')).length, 1);
  } finally { fs.rmSync(state.temporary, {recursive: true, force: true}); }
});

test('a failed health check restores the original application code and retains identity data', () => {
  const state = run({fail: true});
  try {
    assert.equal(state.result.status, 1, state.result.stdout + state.result.stderr);
    assert.match(state.result.stderr, /正在恢复更新前/);
    assert.equal(fs.readFileSync(path.join(state.src, 'app.js'), 'utf8'), "app.use('/', index);\n");
    assert.equal(fs.readFileSync(path.join(state.src, 'controllers/networkController.js'), 'utf8'), fixture);
    assert.equal(fs.existsSync(path.join(state.src, 'nickname-sync')), false);
    assert.equal(fs.readFileSync(path.join(state.root, 'var/lib/zerotier-one/identity.secret'), 'utf8'), 'existing-private-identity');
  } finally { fs.rmSync(state.temporary, {recursive: true, force: true}); }
});

test('an unsupported upstream version is left running and unchanged', () => {
  const state = run({unsupported: true});
  try {
    assert.equal(state.result.status, 1);
    assert.match(state.result.stderr, /未重启服务/);
    assert.equal(fs.readFileSync(path.join(state.src, 'app.js'), 'utf8'), "app.use('/', index);\n");
    assert.equal(fs.readFileSync(state.log, 'utf8').includes('["restart"'), false);
  } finally { fs.rmSync(state.temporary, {recursive: true, force: true}); }
});
