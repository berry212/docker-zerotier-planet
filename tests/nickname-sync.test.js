'use strict';

const {test, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const {createExtension} = require('../patch/nickname-sync');
const {NicknameStore} = require('../patch/nickname-sync/store');
const installer = require('../patch/nickname-sync/install');

const NETWORK = '00ed8fb92f0e3547';
const OTHER_NETWORK = '00ed8fb92f0e3548';
const NODE = '79d0575f06';
const OTHER_NODE = 'd484a54ba7';
let directory, server, base, extension, members, unavailable, listingFormat, listingOverride, onListing, onMemberDetail;

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
  onListing = null;
  onMemberDetail = null;
  const app = express();
  app.use(express.json({limit: '8kb'}));
  app.use(session({secret: 'test-only-secret', resave: false, saveUninitialized: false}));
  // Test fixture only: production uses ztncui's existing login/password middleware.
  app.post('/test/login', (req, res) => { req.session.user = {name: 'admin'}; res.json({ok: true}); });
  app.post('/test/logout', (req, res) => req.session.destroy(() => res.json({ok: true})));
  extension = createExtension({express, filename: path.join(directory, 'state.json'), heartbeatMs: 40,
    legacyName: async id => id === NODE ? 'Chen &amp; &lt;desktop&gt;' : id === '1111111111' ? 'Unbound &amp; Desktop' : undefined,
    zt: {
      member_detail: async (network, node) => {
        if (unavailable) throw new Error('controller is down');
        if (onMemberDetail) await onMemberDetail(network, node);
        const result = members.get(network + node);
        if (!result) { const error = new Error('not found'); error.statusCode = 404; throw error; }
        return result;
      },
      members: async network => {
        if (unavailable) throw new Error('controller is down');
        if (onListing) await onListing();
        if (listingOverride !== undefined) return listingOverride;
        const nodeIds = Array.from(members.keys()).filter(key => key.startsWith(network)).map(key => key.slice(16));
        if (listingFormat === 'array-maps') return nodeIds.map(id => ({[id]: 1}));
        if (listingFormat === 'array-ids') return nodeIds;
        return Object.fromEntries(nodeIds.map(id => [id, 1]));
      },
      network_detail: async network => {
        if (network !== NETWORK && network !== OTHER_NETWORK) throw new Error('not found');
        return {nwid: network};
      }
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
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  if (options.admin) {
    headers.Cookie = options.admin.cookie;
    if (options.csrf !== false) headers['X-Nickname-CSRF'] = options.admin.csrf;
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + route, {method: options.method || 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)});
  const text = await response.text();
  return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null};
}

async function login() {
  const response = await request('/test/login', {method: 'POST'});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const info = await request('/api/v1/admin/session', {headers: {Cookie: cookie}});
  return {cookie, csrf: info.body.csrfToken};
}

const adminMember = (node, network) => '/api/v1/admin/networks/' + (network || NETWORK) + '/members/' + (node || NODE);
const me = network => '/api/v1/networks/' + (network || NETWORK) + '/me';
const memberNames = network => '/api/v1/networks/' + (network || NETWORK) + '/members/nicknames';
const memberName = (node, network) => '/api/v1/networks/' + (network || NETWORK) + '/members/' + (node || OTHER_NODE) + '/nickname';

async function bind(admin, node, network) {
  admin = admin || await login();
  const code = await request(adminMember(node, network) + '/binding-code', {method: 'POST', admin, body: {}});
  assert.equal(code.status, 201);
  const binding = await request('/api/v1/device-bindings/redeem', {method: 'POST', body: {code: code.body.code}});
  assert.equal(binding.status, 201);
  return {admin, code: code.body.code, token: binding.body.token, binding: binding.body};
}

async function events(route, headers) {
  const abort = new AbortController();
  const response = await fetch(base + route, {headers, signal: abort.signal});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
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
          buffer += Buffer.from(chunk.value).toString('utf8');
        }
      } finally { clearTimeout(timer); }
    }
  };
}

test('health is public, nickname and admin endpoints require credentials', async () => {
  assert.equal((await request('/api/v1/nickname-sync/health')).body.version, '1.1.0');
  assert.equal((await request(me() + '/nickname')).status, 401);
  assert.equal((await request(adminMember() + '/nickname')).status, 401);
  assert.equal((await request('/api/v1/admin/session')).status, 401);
  assert.equal((await request(memberNames())).status, 401);
  assert.equal((await request(memberName())).status, 401);
});

test('a bound device can list all authorized members, including offline, unnamed and unbound devices', async () => {
  members.set(NETWORK + '1111111111', {id: '1111111111', authorized: true});
  const {token, admin} = await bind();
  const result = await request(memberNames(), {token});
  assert.equal(result.status, 200);
  assert.equal(result.body.networkId, NETWORK);
  assert.deepEqual(result.body.members.map(record => record.nodeId), ['1111111111', NODE, OTHER_NODE]);
  assert.equal(result.body.members[0].nickname, 'Unbound & Desktop');
  assert.equal(result.body.members[0].updatedBy, 'migration');
  assert.equal(result.body.members[1].nickname, 'Chen & <desktop>');
  assert.equal(result.body.members[2].nickname, '');
  assert.equal(result.body.members[2].version, 0);
  assert.equal(result.body.members[2].updatedAt, null);
  for (const record of result.body.members) {
    assert.deepEqual(Object.keys(record).sort(), ['networkId', 'nickname', 'nodeId', 'updatedAt', 'updatedBy', 'version']);
  }
  await request(adminMember(OTHER_NODE) + '/nickname', {method: 'PATCH', admin, body: {nickname: '同网络电脑', expectedVersion: 0}});
  const single = await request(memberName(), {token});
  assert.equal(single.status, 200);
  assert.equal(single.body.nodeId, OTHER_NODE);
  assert.equal(single.body.nickname, '同网络电脑');
  assert.equal(single.body.updatedBy, 'admin');
});

test('member nickname queries exclude unapproved, deleted, orphaned and other-network records', async () => {
  const {token, admin} = await bind();
  await request(adminMember(OTHER_NODE) + '/nickname', {method: 'PATCH', admin, body: {nickname: 'hidden', expectedVersion: 0}});
  await extension.service.update(NETWORK, 'fffffffffe', 'deleted record', 0, 'admin');
  await extension.service.update(OTHER_NETWORK, 'ffffffffff', 'other-network record', 0, 'admin');
  members.get(NETWORK + OTHER_NODE).authorized = false;
  const result = await request(memberNames(), {token});
  assert.deepEqual(result.body.members.map(record => record.nodeId), [NODE]);
  for (const node of [OTHER_NODE, 'fffffffffe', 'ffffffffff']) {
    const single = await request(memberName(node), {token});
    assert.equal(single.status, 404);
    assert.equal(single.body.error.code, 'member_not_found');
  }
  assert.equal((await request(memberNames(OTHER_NETWORK), {token})).status, 403);
  assert.equal((await request(memberName(NODE, OTHER_NETWORK), {token})).status, 403);
  assert.equal((await request(memberName('invalid'), {token})).status, 400);
});

test('device credentials can read peer names but cannot write them', async () => {
  const {token} = await bind();
  assert.equal((await request(memberName(), {token})).status, 200);
  const response = await fetch(base + memberName(), {method: 'PATCH',
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify({nickname: 'forbidden', expectedVersion: 0})});
  assert.equal(response.status, 404);
  assert.equal((await request(memberName(), {token})).body.nickname, '');
});

test('member directory supports controller map, array-of-maps and array-of-IDs formats', async () => {
  const {token} = await bind();
  for (listingFormat of ['map', 'array-maps', 'array-ids']) {
    const result = await request(memberNames(), {token});
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.members.map(record => record.nodeId), [NODE, OTHER_NODE]);
  }
  listingOverride = [OTHER_NODE, NODE, OTHER_NODE];
  assert.deepEqual((await request(memberNames(), {token})).body.members.map(record => record.nodeId), [NODE, OTHER_NODE]);
});

test('a member deleted during a directory lookup is omitted rather than breaking the request', async () => {
  const {token} = await bind();
  onMemberDetail = async (network, node) => { if (node === OTHER_NODE) members.delete(network + node); };
  const result = await request(memberNames(), {token});
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.members.map(record => record.nodeId), [NODE]);
});

test('directory responses recheck caller authorization and revoked tokens before sending names', async () => {
  const {token} = await bind();
  onListing = async () => { members.get(NETWORK + NODE).authorized = false; };
  assert.equal((await request(memberNames(), {token})).status, 403);
  members.get(NETWORK + NODE).authorized = true;
  onListing = async () => { await extension.service.revoke(NETWORK, NODE, false); };
  assert.equal((await request(memberNames(), {token})).status, 401);
});

test('single-member lookups recheck caller authorization after loading a peer', async () => {
  const {token} = await bind();
  onMemberDetail = async (network, node) => {
    if (node === OTHER_NODE) members.get(NETWORK + NODE).authorized = false;
  };
  assert.equal((await request(memberName(), {token})).status, 403);
});

test('unauthorized callers and expired credentials cannot use member nickname queries', async () => {
  const {token} = await bind();
  members.get(NETWORK + NODE).authorized = false;
  assert.equal((await request(memberNames(), {token})).status, 403);
  assert.equal((await request(memberName(), {token})).status, 403);
  members.get(NETWORK + NODE).authorized = true;
  await extension.service.transaction(state => {
    state.tokens[crypto.createHash('sha256').update(token).digest('hex')].expiresAt = 0;
  });
  assert.equal((await request(memberNames(), {token})).status, 401);
  assert.equal((await request(memberName(), {token})).status, 401);
});

test('directory ETags change for nickname changes, authorization changes and deleted members', async () => {
  const {token, admin} = await bind();
  const first = await request(memberNames(), {token});
  assert.equal((await request(memberNames(), {token, headers: {'If-None-Match': first.headers.get('etag')}})).status, 304);
  await request(adminMember(OTHER_NODE) + '/nickname', {method: 'PATCH', admin, body: {nickname: 'new', expectedVersion: 0}});
  const changed = await request(memberNames(), {token, headers: {'If-None-Match': first.headers.get('etag')}});
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), first.headers.get('etag'));
  members.get(NETWORK + OTHER_NODE).authorized = false;
  const hidden = await request(memberNames(), {token, headers: {'If-None-Match': changed.headers.get('etag')}});
  assert.equal(hidden.status, 200);
  assert.notEqual(hidden.headers.get('etag'), changed.headers.get('etag'));
  members.get(NETWORK + OTHER_NODE).authorized = true;
  await request(memberNames(), {token});
  members.delete(NETWORK + OTHER_NODE);
  assert.equal((await request(memberNames(), {token})).body.members.length, 1);
});

test('invalid controller member listings and listing failures return 503 without partial data', async () => {
  const {token} = await bind();
  for (listingOverride of [null, 1, {bad: 1}, [null], [42], [['bad']]]) {
    const result = await request(memberNames(), {token});
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'controller_unavailable');
    assert.equal(result.body.members, undefined);
  }
  listingOverride = undefined;
  onListing = async () => { throw new Error('connection failed'); };
  assert.equal((await request(memberNames(), {token})).status, 503);
});

test('binding codes are single-use, secrets are hashed, and old names migrate as plain text', async () => {
  const binding = await bind();
  assert.equal(binding.binding.nickname.nickname, 'Chen & <desktop>');
  assert.equal(binding.binding.nickname.version, 1);
  const again = await request('/api/v1/device-bindings/redeem', {method: 'POST', body: {code: binding.code}});
  assert.equal(again.status, 401);
  const persisted = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
  assert.equal(persisted.includes(binding.token), false);
  assert.equal(persisted.includes(binding.code), false);
  assert.equal(fs.statSync(path.join(directory, 'state.json')).mode & 0o777, 0o600);
});

test('App and admin read/write one record, including Unicode and clearing a name', async () => {
  const {token, admin} = await bind();
  let result = await request(me() + '/nickname', {method: 'PATCH', token,
    body: {nickname: ' 陈的笔记本 🐈 ', expectedVersion: 1, nodeId: OTHER_NODE}});
  assert.equal(result.status, 200);
  assert.equal(result.body.nickname, '陈的笔记本 🐈');
  assert.equal(result.body.nodeId, NODE);
  result = await request(adminMember() + '/nickname', {admin});
  assert.equal(result.body.nickname, '陈的笔记本 🐈');
  result = await request(adminMember() + '/nickname', {method: 'PATCH', admin,
    body: {nickname: '管理员改名', expectedVersion: 2}});
  assert.equal(result.body.updatedBy, 'admin');
  assert.equal((await request(me() + '/nickname', {token})).body.nickname, '管理员改名');
  result = await request(me() + '/nickname', {method: 'PATCH', token, body: {nickname: '', expectedVersion: 3}});
  assert.equal(result.body.nickname, '');
  assert.equal(result.body.version, 4);
  assert.equal((await request(adminMember(OTHER_NODE) + '/nickname', {admin})).body.nickname, '');
});

test('concurrent changes use atomic version checks; stale retries do not overwrite', async () => {
  const {token, admin} = await bind();
  const results = await Promise.all([
    request(me() + '/nickname', {method: 'PATCH', token, body: {nickname: 'App', expectedVersion: 1}}),
    request(adminMember() + '/nickname', {method: 'PATCH', admin, body: {nickname: 'Admin', expectedVersion: 1}})
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.find(result => result.status === 200).body;
  const conflict = results.find(result => result.status === 409).body;
  assert.equal(conflict.current.nickname, winner.nickname);
  assert.equal(conflict.current.version, 2);
  const stale = await request(me() + '/nickname', {method: 'PATCH', token, body: {nickname: 'old', expectedVersion: 1}});
  assert.equal(stale.status, 409);
  assert.equal((await request(me() + '/nickname', {token})).body.nickname, winner.nickname);
});

test('tokens and names are scoped to a network', async () => {
  const {token, admin} = await bind();
  assert.equal((await request(me(OTHER_NETWORK) + '/nickname', {token})).status, 403);
  const other = await bind(admin, NODE, OTHER_NETWORK);
  await request(me() + '/nickname', {method: 'PATCH', token, body: {nickname: '办公电脑', expectedVersion: 1}});
  assert.equal((await request(me(OTHER_NETWORK) + '/nickname', {token: other.token})).body.nickname, 'Chen & <desktop>');
});

test('CSRF is required even with an admin session', async () => {
  const admin = await login();
  assert.equal((await request(adminMember() + '/binding-code', {method: 'POST', admin, csrf: false, body: {}})).status, 403);
  assert.equal((await request(adminMember() + '/nickname', {method: 'PATCH', admin, csrf: false,
    body: {nickname: 'attack', expectedVersion: 1}})).status, 403);
  const unicode = await request(adminMember() + '/binding-code', {method: 'POST', headers: {
    Cookie: admin.cookie, 'X-Nickname-CSRF': 'é'.repeat(64)}, body: {}});
  assert.equal(unicode.status, 403);
});

test('the legacy form rename handler returns JSON errors without requiring an Express next callback', async () => {
  let status, body;
  const response = {headersSent: false, status(value) { status = value; return this; }, json(value) { body = value; }};
  await extension.handleLegacyRename({method: 'POST', session: {user: {name: 'admin'}}, get: () => undefined}, response);
  assert.equal(status, 403);
  assert.equal(body.error.code, 'invalid_csrf');
});

test('expired codes and unapproved or removed members cannot bind or sync', async () => {
  const {token, admin} = await bind();
  members.get(NETWORK + NODE).authorized = false;
  assert.equal((await request(me() + '/nickname', {token})).status, 403);
  assert.equal((await request(adminMember() + '/binding-code', {method: 'POST', admin, body: {}})).status, 403);
  members.get(NETWORK + NODE).authorized = true;
  const code = await request(adminMember() + '/binding-code', {method: 'POST', admin, body: {}});
  await extension.service.transaction(state => { state.codes[crypto.createHash('sha256').update(code.body.code).digest('hex')].expiresAt = 0; });
  assert.equal((await request('/api/v1/device-bindings/redeem', {method: 'POST', body: {code: code.body.code}})).status, 401);
  members.delete(NETWORK + NODE);
  assert.equal((await request(me() + '/nickname', {token})).status, 403);
});

test('rebind replaces old tokens; explicit revocation invalidates tokens and pending codes', async () => {
  const first = await bind();
  const second = await bind(first.admin);
  assert.equal((await request(me() + '/nickname', {token: first.token})).status, 401);
  assert.equal((await request(me() + '/nickname', {token: second.token})).status, 200);
  const code = await request(adminMember() + '/binding-code', {method: 'POST', admin: first.admin, body: {}});
  assert.equal((await request(adminMember() + '/binding', {method: 'DELETE', admin: first.admin})).status, 204);
  assert.equal((await request(me() + '/nickname', {token: second.token})).status, 401);
  assert.equal((await request('/api/v1/device-bindings/redeem', {method: 'POST', body: {code: code.body.code}})).status, 401);
});

test('SSE sends initial state, both directions of edits, and credential revocation', async () => {
  const {token, admin} = await bind();
  const deviceStream = await events(me() + '/events', {Authorization: 'Bearer ' + token});
  const adminStream = await events('/api/v1/admin/networks/' + NETWORK + '/events', {Cookie: admin.cookie});
  try {
    assert.equal((await deviceStream.next('nickname')).version, 1);
    assert.equal((await adminStream.next('nickname')).version, 1);
    await request(adminMember() + '/nickname', {method: 'PATCH', admin, body: {nickname: '从管理端修改', expectedVersion: 1}});
    assert.equal((await deviceStream.next('nickname')).nickname, '从管理端修改');
    await adminStream.next('nickname');
    await request(me() + '/nickname', {method: 'PATCH', token, body: {nickname: '从 App 修改', expectedVersion: 2}});
    assert.equal((await deviceStream.next('nickname')).version, 3);
    assert.equal((await adminStream.next('nickname')).nickname, '从 App 修改');
    await request(adminMember() + '/binding', {method: 'DELETE', admin});
    assert.equal((await deviceStream.next('revoked')).code, 'invalid_token');
  } finally { deviceStream.close(); adminStream.close(); }
});

test('open SSE connections recheck membership and admin login sessions', async () => {
  const {token, admin} = await bind();
  const deviceStream = await events(me() + '/events', {Authorization: 'Bearer ' + token});
  const adminStream = await events('/api/v1/admin/networks/' + NETWORK + '/events', {Cookie: admin.cookie});
  try {
    await deviceStream.next('nickname');
    await adminStream.next('nickname');
    members.get(NETWORK + NODE).authorized = false;
    assert.equal((await deviceStream.next('revoked')).code, 'membership_required');
    await request('/test/logout', {method: 'POST', headers: {Cookie: admin.cookie}});
    assert.equal((await adminStream.next('revoked')).code, 'admin_login_required');
  } finally { deviceStream.close(); adminStream.close(); }
});

test('a restarted store retains names, credentials, versions, and does not resurrect deleted legacy names', async () => {
  const {token} = await bind();
  await request(me() + '/nickname', {method: 'PATCH', token, body: {nickname: '持久化', expectedVersion: 1}});
  const restarted = new NicknameStore(path.join(directory, 'state.json'), async () => 'old');
  assert.equal(restarted.authenticate(token).nodeId, NODE);
  assert.equal((await restarted.get(NETWORK, NODE)).nickname, '持久化');
  await restarted.revoke(NETWORK, NODE, true);
  assert.equal((await restarted.get(NETWORK, NODE)).nickname, '');
  assert.throws(() => restarted.authenticate(token), error => error.status === 401);
});

test('revocation ordered before a device write prevents the write inside the transaction', async () => {
  const {token} = await bind();
  const revoke = extension.service.revoke(NETWORK, NODE, false);
  const update = extension.service.update(NETWORK, NODE, 'forbidden', 1, 'device', token);
  await revoke;
  await assert.rejects(update, error => error.status === 401);
  assert.equal((await extension.service.get(NETWORK, NODE)).version, 1);
});

test('invalid input, malformed JSON, invalid IDs and controller failures return structured errors', async () => {
  const {token} = await bind();
  for (const nickname of [null, 42, 'x'.repeat(65), 'bad\nname', 'bad\u202ename']) {
    assert.equal((await request(me() + '/nickname', {method: 'PATCH', token, body: {nickname, expectedVersion: 1}})).status, 400);
  }
  assert.equal((await request(me() + '/nickname', {method: 'PATCH', token, body: {nickname: 'ok', expectedVersion: '1'}})).status, 400);
  assert.equal((await request(me('invalid') + '/nickname', {token})).status, 400);
  const badJson = await fetch(base + me() + '/nickname', {method: 'PATCH',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token}, body: '{'});
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'invalid_json');
  unavailable = true;
  const failed = await request(me() + '/nickname', {token});
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, 'controller_unavailable');
});

test('ETags avoid repeated payloads, and no-op edits preserve the version', async () => {
  const {token} = await bind();
  const first = await request(me() + '/nickname', {token});
  assert.equal((await request(me() + '/nickname', {token, headers: {'If-None-Match': first.headers.get('etag')}})).status, 304);
  const noChange = await request(me() + '/nickname', {method: 'PATCH', token,
    body: {nickname: first.body.nickname, expectedVersion: first.body.version}});
  assert.equal(noChange.body.version, first.body.version);
});

test('corrupt persisted data fails closed instead of resetting credentials or names', () => {
  const filename = path.join(directory, 'broken.json');
  fs.writeFileSync(filename, '{broken');
  assert.throws(() => new NicknameStore(filename));
  assert.equal(fs.readFileSync(filename, 'utf8'), '{broken');
});

test('unsupported ztncui sources are rejected before any files change', () => {
  fs.mkdirSync(path.join(directory, 'controllers'));
  fs.mkdirSync(path.join(directory, 'views'));
  fs.writeFileSync(path.join(directory, 'app.js'), "app.use('/', index);\n");
  fs.writeFileSync(path.join(directory, 'controllers/networkController.js'), '// unsupported upstream\n');
  fs.writeFileSync(path.join(directory, 'views/network_detail.pug'), '// unsupported upstream\n');
  assert.throws(() => installer.install(directory), /Unsupported/);
  assert.equal(fs.readFileSync(path.join(directory, 'app.js'), 'utf8'), "app.use('/', index);\n");
  assert.equal(fs.existsSync(path.join(directory, '.nickname-sync-backups')), false);
});
