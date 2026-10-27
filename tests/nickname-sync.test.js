'use strict';

const {test, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const {createExtension} = require('../patch/nickname-sync');
const {NicknameStore} = require('../patch/nickname-sync/store');
const installer = require('../patch/nickname-sync/install');

const NETWORK = '00ed8fb92f0e3547';
const OTHER_NETWORK = '00ed8fb92f0e3548';
const NODE = '79d0575f06';
const OTHER_NODE = 'd484a54ba7';
let directory, server, base, extension, members, unavailable, listingFormat, listingOverride, onMemberDetail;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nickname-test-'));
  members = new Map([
    [NETWORK + NODE, {id: NODE, authorized: true}],
    [NETWORK + OTHER_NODE, {id: OTHER_NODE, authorized: true}],
    [OTHER_NETWORK + NODE, {id: NODE, authorized: true}]
  ]);
  unavailable = false;
  listingFormat = 'map';
  listingOverride = undefined;
  onMemberDetail = null;
  const app = express();
  app.use(express.json({limit: '8kb'}));
  app.use(session({secret: 'test-only-secret', resave: false, saveUninitialized: false}));
  // Test-only login fixture. Production retains the existing ztncui login.
  app.post('/test/login', (req, res) => { req.session.user = {name: 'admin'}; res.json({ok: true}); });
  app.post('/test/logout', (req, res) => req.session.destroy(() => res.json({ok: true})));
  extension = createExtension({express, filename: path.join(directory, 'state.json'), heartbeatMs: 40,
    legacyName: async id => id === NODE ? 'Chen &amp; &lt;desktop&gt;' : id === '1111111111' ? 'Old &amp; Desktop' : undefined,
    zt: {
      member_detail: async (network, node) => {
        if (unavailable) throw new Error('controller is down');
        if (onMemberDetail) await onMemberDetail(network, node);
        const result = members.get(network + node);
        if (!result) { const error = new Error('not found'); error.statusCode = 404; throw error; }
        return Object.assign({}, result);
      },
      members: async network => {
        if (unavailable) throw new Error('controller is down');
        if (listingOverride !== undefined) return listingOverride;
        const ids = Array.from(members.keys()).filter(key => key.startsWith(network)).map(key => key.slice(16));
        if (listingFormat === 'array-maps') return ids.map(id => ({[id]: 1}));
        if (listingFormat === 'array-ids') return ids;
        return Object.fromEntries(ids.map(id => [id, 1]));
      },
      network_detail: async nwid => ({nwid})
    }});
  extension.install(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await extension.service.queue;
  fs.rmSync(directory, {recursive: true, force: true});
});

async function request(route, options) {
  options = options || {};
  const headers = Object.assign({}, options.headers);
  if (options.admin) {
    headers.Cookie = options.admin.cookie;
    if (options.csrf !== false) headers['X-Nickname-CSRF'] = options.admin.csrf;
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + route, {method: options.method || 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)});
  const text = await response.text();
  return {status: response.status, headers: response.headers,
    body: text ? response.headers.get('content-type').includes('application/json') ? JSON.parse(text) : text : null};
}

async function login() {
  const response = await request('/test/login', {method: 'POST'});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const info = await request('/api/v1/admin/session', {headers: {Cookie: cookie}});
  return {cookie, csrf: info.body.csrfToken};
}

const memberBase = (node, network) => '/api/v1/networks/' + (network || NETWORK) + '/members/' + (node || NODE);
const name = (node, network) => memberBase(node, network) + '/nickname';
const names = network => '/api/v1/networks/' + (network || NETWORK) + '/members/nicknames';
const adminBase = (node, network) => '/api/v1/admin/networks/' + (network || NETWORK) + '/members/' + (node || NODE);
const edit = (nickname, expectedVersion) => ({method: 'PATCH', body: {nickname, expectedVersion}});

async function events(route, headers) {
  const abort = new AbortController();
  const response = await fetch(base + route, {headers, signal: abort.signal});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    close: () => abort.abort(),
    next: async expected => {
      const timer = setTimeout(() => abort.abort(), 3000);
      try {
        while (true) {
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = /^event: (.*)$/m.exec(frame);
            const data = /^data: (.*)$/m.exec(frame);
            if (event && event[1] === expected) return JSON.parse(data[1]);
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Stream closed before ' + expected);
          buffer += decoder.decode(chunk.value, {stream: true});
        }
      } finally { clearTimeout(timer); }
    }
  };
}

test('public nickname reads and edits require no token, session, binding or extra identity headers', async () => {
  assert.equal((await request('/api/v1/nickname-sync/health')).body.version, '2.0.0');
  const first = await request(name());
  assert.equal(first.status, 200);
  assert.equal(first.body.nickname, 'Chen & <desktop>');
  assert.equal((await request(name(), edit('陈的电脑', 1))).status, 200);
  assert.equal((await request(name())).body.nickname, '陈的电脑');
  // Caller-supplied IDs select the record. This intentionally does not prove ownership.
  assert.equal((await request(name(OTHER_NODE), edit('另一台电脑', 0))).status, 200);
  assert.equal((await request(name(OTHER_NODE))).body.nickname, '另一台电脑');
  assert.equal((await request(names())).status, 200);
});

test('App and existing Member name share names, Unicode values, versions and empty names', async () => {
  const admin = await login();
  let result = await request(name(), edit(' 陈的笔记本 🐈 ', 1));
  assert.equal(result.body.nickname, '陈的笔记本 🐈');
  assert.equal(result.body.updatedBy, 'device');
  assert.equal((await request(adminBase() + '/nickname', {admin})).body.nickname, '陈的笔记本 🐈');
  result = await request(adminBase() + '/nickname', Object.assign(edit('管理员改名', 2), {admin}));
  assert.equal(result.body.updatedBy, 'admin');
  assert.equal((await request(name())).body.nickname, '管理员改名');
  result = await request(name(), edit('', 3));
  assert.equal(result.body.nickname, '');
  assert.equal(result.body.version, 4);
});

test('concurrent writes and stale offline caches cannot silently overwrite a newer nickname', async () => {
  const admin = await login();
  const results = await Promise.all([
    request(name(), edit('App', 1)),
    request(adminBase() + '/nickname', Object.assign(edit('Admin', 1), {admin}))
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.find(result => result.status === 200).body;
  const conflict = results.find(result => result.status === 409).body;
  assert.equal(conflict.current.nickname, winner.nickname);
  assert.equal(conflict.current.version, 2);
  assert.equal((await request(name(), edit('offline old value', 1))).status, 409);
});

test('SSE sends the initial snapshot and both directions of nickname updates without App login', async () => {
  const admin = await login();
  const client = await events(memberBase() + '/events');
  const panel = await events('/api/v1/admin/networks/' + NETWORK + '/events', {Cookie: admin.cookie});
  try {
    assert.equal((await client.next('nickname')).version, 1);
    assert.equal((await panel.next('nickname')).version, 1);
    await request(name(), edit('客户端改名', 1));
    assert.equal((await panel.next('nickname')).nickname, '客户端改名');
    assert.equal((await client.next('nickname')).version, 2);
    await request(adminBase() + '/nickname', Object.assign(edit('网页 Member name', 2), {admin}));
    assert.equal((await client.next('nickname')).nickname, '网页 Member name');
    assert.equal((await panel.next('nickname')).version, 3);
    const reconnected = await events(memberBase() + '/events');
    try { assert.equal((await reconnected.next('nickname')).version, 3); } finally { reconnected.close(); }
  } finally { client.close(); panel.close(); }
});

test('the normal admin login and CSRF protection remain on management endpoints only', async () => {
  assert.equal((await request(adminBase() + '/nickname')).status, 401);
  const admin = await login();
  assert.equal((await request(adminBase() + '/nickname', Object.assign(edit('bad', 1), {admin, csrf: false}))).status, 403);
  let status, body;
  const response = {headersSent: false, status(value) { status = value; return this; }, json(value) { body = value; }};
  await extension.handleLegacyRename({method: 'POST', session: {user: 'admin'}, get: () => undefined}, response);
  assert.equal(status, 403);
  assert.equal(body.error.code, 'invalid_csrf');
});

test('missing and unapproved members cannot be read, edited or watched through public endpoints', async () => {
  members.get(NETWORK + NODE).authorized = false;
  for (const route of [name(), memberBase() + '/events']) assert.equal((await request(route)).status, 403);
  assert.equal((await request(name(), edit('not allowed', 1))).status, 403);
  members.delete(NETWORK + NODE);
  assert.equal((await request(name())).status, 403);
  assert.equal((await request(name(), edit('missing', 0))).status, 403);
  assert.equal((await request(name('invalid'))).status, 400);
  assert.equal((await request(name(NODE, 'invalid'))).status, 400);
});

test('membership is rechecked within a queued write before committing the change', async () => {
  await request(name());
  let count = 0;
  onMemberDetail = async () => { if (++count === 2) members.get(NETWORK + NODE).authorized = false; };
  assert.equal((await request(name(), edit('should not be saved', 1))).status, 403);
  assert.equal((await extension.service.get(NETWORK, NODE)).version, 1);
});

test('public member lists include offline devices and migrate legacy names without an App registration', async () => {
  members.set(NETWORK + '1111111111', {id: '1111111111', authorized: true});
  const result = await request(names());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.members.map(record => record.nodeId), ['1111111111', NODE, OTHER_NODE]);
  assert.equal(result.body.members[0].nickname, 'Old & Desktop');
  assert.equal(result.body.members[2].nickname, '');
  assert.equal(result.body.members[2].version, 0);
  for (const record of result.body.members) {
    assert.deepEqual(Object.keys(record).sort(), ['networkId', 'nickname', 'nodeId', 'updatedAt', 'updatedBy', 'version']);
  }
});

test('directory queries do not include unapproved, deleted, orphaned or other-network records', async () => {
  await extension.service.update(NETWORK, 'fffffffffe', 'orphan', 0, 'admin');
  await extension.service.update(OTHER_NETWORK, NODE, '家庭电脑', 1, 'admin');
  members.get(NETWORK + OTHER_NODE).authorized = false;
  assert.deepEqual((await request(names())).body.members.map(record => record.nodeId), [NODE]);
  assert.equal((await request(name(NODE, OTHER_NETWORK))).body.nickname, '家庭电脑');
  assert.equal((await request(name())).body.nickname, 'Chen & <desktop>');
});

test('directory normalization accepts controller map and array formats, and tolerates a member disappearing', async () => {
  for (listingFormat of ['map', 'array-maps', 'array-ids']) {
    assert.deepEqual((await request(names())).body.members.map(record => record.nodeId), [NODE, OTHER_NODE]);
  }
  listingOverride = [OTHER_NODE, NODE, OTHER_NODE];
  assert.deepEqual((await request(names())).body.members.map(record => record.nodeId), [NODE, OTHER_NODE]);
  onMemberDetail = async (network, node) => { if (node === OTHER_NODE) members.delete(network + node); };
  assert.deepEqual((await request(names())).body.members.map(record => record.nodeId), [NODE]);
});

test('ETags detect name and membership changes while still checking selected member authorization', async () => {
  const first = await request(name());
  assert.equal((await request(name(), {headers: {'If-None-Match': first.headers.get('etag')}})).status, 304);
  const list = await request(names());
  assert.equal((await request(names(), {headers: {'If-None-Match': list.headers.get('etag')}})).status, 304);
  await request(name(OTHER_NODE), edit('other', 0));
  assert.equal((await request(names(), {headers: {'If-None-Match': list.headers.get('etag')}})).status, 200);
  members.get(NETWORK + NODE).authorized = false;
  assert.equal((await request(name(), {headers: {'If-None-Match': first.headers.get('etag')}})).status, 403);
});

test('SSE stops when authorization is removed and on explicit member deletion', async () => {
  const first = await events(memberBase() + '/events');
  try {
    await first.next('nickname');
    members.get(NETWORK + NODE).authorized = false;
    assert.equal((await first.next('removed')).code, 'membership_required');
  } finally { first.close(); }
  members.get(NETWORK + NODE).authorized = true;
  const second = await events(memberBase() + '/events');
  try {
    await second.next('nickname');
    await extension.service.remove(NETWORK, NODE);
    assert.equal((await second.next('removed')).code, 'membership_required');
  } finally { second.close(); }
});

test('SSE reports controller outages and existing admin sessions ending', async () => {
  const admin = await login();
  const panel = await events('/api/v1/admin/networks/' + NETWORK + '/events', {Cookie: admin.cookie});
  try {
    await request('/test/logout', {method: 'POST', headers: {Cookie: admin.cookie}});
    assert.equal((await panel.next('removed')).code, 'admin_login_required');
  } finally { panel.close(); }
  const client = await events(memberBase() + '/events');
  try {
    await client.next('nickname');
    unavailable = true;
    assert.equal((await client.next('unavailable')).code, 'controller_unavailable');
  } finally { client.close(); }
});

test('input validation, malformed JSON and controller outages return structured errors', async () => {
  for (const nickname of [null, 42, 'x'.repeat(65), 'bad\nname', 'bad\u202ename']) {
    assert.equal((await request(name(), edit(nickname, 1))).status, 400);
  }
  assert.equal((await request(name(), edit('ok', '1'))).status, 400);
  const malformed = await fetch(base + name(), {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: '{'});
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_json');
  for (listingOverride of [null, 1, {bad: 1}, [null], [42], [['bad']]]) {
    const result = await request(names());
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'controller_unavailable');
  }
  listingOverride = undefined;
  unavailable = true;
  assert.equal((await request(name())).status, 503);
  assert.equal((await request(names())).status, 503);
});

test('old binding and implicit me endpoints no longer exist', async () => {
  assert.equal((await request('/api/v1/device-bindings/redeem', {method: 'POST', body: {code: 'old'}})).status, 404);
  assert.equal((await request('/api/v1/networks/' + NETWORK + '/me/nickname')).status, 404);
  const admin = await login();
  assert.equal((await request(adminBase() + '/binding-code', {method: 'POST', admin, body: {}})).status, 404);
  assert.equal((await request(adminBase() + '/binding', {method: 'DELETE', admin})).status, 404);
  assert.equal(extension.service.authenticate, undefined);
  assert.equal(extension.service.createCode, undefined);
});

test('migration discards obsolete credentials and retains durable names and versions for code rollback', async () => {
  const filename = path.join(directory, 'legacy.json');
  const record = {networkId: NETWORK, nodeId: NODE, nickname: '保留的昵称', version: 7, updatedAt: null, updatedBy: 'admin'};
  fs.writeFileSync(filename, JSON.stringify({schema: 1, records: {[NETWORK + ':' + NODE]: record},
    codes: {old: {networkId: NETWORK, nodeId: NODE}}, tokens: {old: {networkId: NETWORK, nodeId: NODE}}, suppressedLegacy: {}}));
  const upgraded = new NicknameStore(filename, async () => 'old');
  assert.deepEqual(await upgraded.get(NETWORK, NODE), record);
  const persisted = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.deepEqual(persisted.codes, {});
  assert.deepEqual(persisted.tokens, {});
  assert.equal(persisted.schema, 1);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  await upgraded.update(NETWORK, NODE, '新昵称', 7, 'device');
  const restarted = new NicknameStore(filename, async () => 'old legacy name');
  assert.equal((await restarted.get(NETWORK, NODE)).nickname, '新昵称');
  await restarted.remove(NETWORK, NODE);
  assert.equal((await restarted.get(NETWORK, NODE)).nickname, '');
});

test('corrupt persisted state fails closed', () => {
  const filename = path.join(directory, 'broken.json');
  fs.writeFileSync(filename, '{broken');
  assert.throws(() => new NicknameStore(filename));
  assert.equal(fs.readFileSync(filename, 'utf8'), '{broken');
});

test('unsupported ztncui sources are rejected before any source files change', () => {
  fs.mkdirSync(path.join(directory, 'controllers'));
  fs.mkdirSync(path.join(directory, 'views'));
  fs.writeFileSync(path.join(directory, 'app.js'), "app.use('/', index);\n");
  fs.writeFileSync(path.join(directory, 'controllers/networkController.js'), '// unsupported\n');
  fs.writeFileSync(path.join(directory, 'views/network_detail.pug'), '// unsupported\n');
  assert.throws(() => installer.install(directory), /Unsupported/);
  assert.equal(fs.readFileSync(path.join(directory, 'app.js'), 'utf8'), "app.use('/', index);\n");
});

test('upgrading the previous patch removes added UI and preserves the Member name input', () => {
  fs.mkdirSync(path.join(directory, 'controllers'));
  fs.mkdirSync(path.join(directory, 'views'));
  fs.writeFileSync(path.join(directory, 'app.js'), "// nickname-sync:v1\nrequire('./nickname-sync').install(app);\n");
  fs.writeFileSync(path.join(directory, 'controllers/networkController.js'), '// nickname-sync:v1\nconst result = nicknames.revoke(req.params.nwid, member.id, true);\n');
  fs.writeFileSync(path.join(directory, 'views/network_detail.pug'), `// nickname-sync:v1
block content
  h3 Members
  #nickname-sync-settings(data-network=network.nwid data-csrf=nicknameSyncCsrf)
  table
    tr
      td
              input.form-control.nickname-sync-name(type='text' name=member.id value=member.name data-version=member.nicknameVersion maxlength='128')
              button.btn.btn-default.btn-xs.nickname-sync-bind(type='button' style='margin-top: 5px') 绑定 App
              |${'  '}
              button.btn.btn-default.btn-xs.nickname-sync-revoke(type='button' style='margin-top: 5px') 撤销绑定
              small.nickname-sync-status(style='display: block' role='status')
`);
  assert.equal(installer.install(directory), 3);
  assert.equal(installer.install(directory), 0);
  const view = fs.readFileSync(path.join(directory, 'views/network_detail.pug'), 'utf8');
  assert(!/绑定 App|撤销绑定|nickname-sync-status|button\./.test(view));
  assert(view.includes('input.form-control.text.nickname-sync-name'));
  assert(view.includes("style='display: none'"));
  assert(view.includes('h3 Members'));
  assert(fs.readFileSync(path.join(directory, 'controllers/networkController.js'), 'utf8').includes('nicknames.remove('));
});
