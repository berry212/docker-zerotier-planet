'use strict';

// Optional integration smoke test against a temporary copy of actual upstream
// ztncui sources (app.js, networkController.js and the four inherited Pug files).
// The fixture's controller transport is replaced with an in-memory test double.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(process.argv[2] || '');
if (!root.startsWith('/tmp/ztncui-nickname-upstream.')) {
  throw new Error('Pass a temporary /tmp/ztncui-nickname-upstream.* fixture directory');
}

async function main() {
  const installer = require('../patch/nickname-sync/install');
  const appBefore = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const changed = installer.install(root);
  assert.strictEqual(changed, appBefore.includes('nickname-sync:v1') ? 0 : 3);
  assert.strictEqual(installer.install(root), 0);
  const target = path.join(root, 'nickname-sync');
  fs.mkdirSync(target, {recursive: true});
  for (const file of fs.readdirSync(path.join(__dirname, '../patch/nickname-sync'))) {
    fs.copyFileSync(path.join(__dirname, '../patch/nickname-sync', file), path.join(target, file));
  }
  if (!fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'controllers/zt.js'), `module.exports = {
    network_detail: async nwid => ({nwid, name: 'test-network'}),
    peers: async () => [], peer: async () => null,
    members: async () => ({'79d0575f06': 1}),
    member_detail: async (nwid, id) => ({id, address: id, authorized: true, ipAssignments: []}),
    get_zt_address: async () => '00ed8fb92f'
  };\n`);
  process.chdir(root);
  process.env.NICKNAME_STORE_PATH = path.join(root, 'nickname-state.json');
  if (fs.existsSync(process.env.NICKNAME_STORE_PATH)) fs.unlinkSync(process.env.NICKNAME_STORE_PATH);
  const controller = require(path.join(root, 'controllers/networkController'));
  const storage = require(path.join(__dirname, 'node_modules/node-persist'));
  await storage.setItem('79d0575f06', 'Chen &amp; &lt;desktop&gt;');
  let detail;
  await controller.network_detail({params: {nwid: '00ed8fb92f0e3547'}}, {render(view, data) {
    assert.strictEqual(data.error, undefined);
    assert.strictEqual(view, 'network_detail');
    detail = data;
  }});
  assert.strictEqual(detail.members[0].name, 'Chen & <desktop>');
  assert.strictEqual(detail.members[0].nicknameVersion, 1);
  const pug = require('pug');
  let html = pug.renderFile(path.join(root, 'views/network_detail.pug'), Object.assign(detail, {nicknameSyncCsrf: 'a'.repeat(64)}));
  assert(html.includes('nickname-sync-name'));
  assert(html.includes('data-version="1"'));
  assert(html.includes('绑定 App'));
  assert(html.includes('/nickname-sync/browser.js'));
  assert(html.includes('Chen &amp; &lt;desktop&gt;'));
  const extension = require(target);
  await extension.service.update('00ed8fb92f0e3547', '79d0575f06', '<script>alert("x")</script>', 1, 'admin');
  await controller.network_detail({params: {nwid: '00ed8fb92f0e3547'}}, {render(view, data) { detail = data; }});
  html = pug.renderFile(path.join(root, 'views/network_detail.pug'), Object.assign(detail, {nicknameSyncCsrf: 'b'.repeat(64)}));
  assert(html.includes('data-version="2"'));
  assert(!html.includes('<script>alert("x")</script>'));
  assert.strictEqual(await storage.getItem('79d0575f06'), 'Chen &amp; &lt;desktop&gt;');
  console.log('Upstream controller, migration, idempotent patch and Pug rendering passed on ' + process.version);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
