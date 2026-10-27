'use strict';

const crypto = require('crypto');
const path = require('path');
const {NicknameStore, ApiError} = require('./store');
const version = require('./version.json').version;

const asyncRoute = action => (req, res, next) => Promise.resolve(action(req, res, next)).catch(next);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function createExtension(options) {
  const express = options.express;
  const zt = options.zt;
  const service = new NicknameStore(options.filename, options.legacyName);
  const streams = new Map();
  let streamCount = 0;

  function ids(networkId, nodeId) {
    if (!/^[a-f0-9]{16}$/.test(networkId || '') || (nodeId !== undefined && !/^[a-f0-9]{10}$/.test(nodeId))) {
      throw new ApiError(400, 'invalid_id', 'Expected a lowercase 16-digit network ID and 10-digit node ID');
    }
  }

  async function memberDetail(networkId, nodeId) {
    let record;
    try { record = await zt.member_detail(networkId, nodeId); } catch (error) {
      if (error.statusCode === 404 || (error.response && error.response.statusCode === 404)) {
        return null;
      }
      throw new ApiError(503, 'controller_unavailable', 'Cannot verify membership with the ZeroTier controller');
    }
    return record;
  }

  async function member(networkId, nodeId, authorized) {
    const record = await memberDetail(networkId, nodeId);
    if (!record || record.id !== nodeId || (authorized && record.authorized !== true)) {
      throw new ApiError(403, 'membership_required', 'Device must be an authorized member of this network');
    }
    return record;
  }

  async function authorizedMemberIds(networkId) {
    let listing;
    try { listing = await zt.members(networkId); } catch (error) {
      throw new ApiError(503, 'controller_unavailable', 'Cannot list members from the ZeroTier controller');
    }
    // ZeroTier versions return either an ID-to-revision map or an array of
    // single-entry maps. Accept plain ID arrays as well.
    const entries = Array.isArray(listing) ? listing : [listing];
    const collected = [];
    for (const entry of entries) {
      if (typeof entry === 'string' && Array.isArray(listing)) collected.push(entry);
      else if (entry && typeof entry === 'object' && !Array.isArray(entry)) collected.push(...Object.keys(entry));
      else throw new ApiError(503, 'controller_unavailable', 'Unexpected controller member list format');
    }
    if (collected.some(nodeId => !/^[a-f0-9]{10}$/.test(nodeId))) {
      throw new ApiError(503, 'controller_unavailable', 'Unexpected controller member ID');
    }
    const candidates = Array.from(new Set(collected)).sort();
    const authorized = [];
    // Bound local-controller concurrency instead of opening one request per
    // member simultaneously. A member deleted during the lookup is omitted.
    for (let offset = 0; offset < candidates.length; offset += 8) {
      const batch = candidates.slice(offset, offset + 8);
      const records = await Promise.all(batch.map(nodeId => memberDetail(networkId, nodeId)));
      records.forEach((record, index) => {
        if (record && record.id === batch[index] && record.authorized === true) authorized.push(batch[index]);
      });
    }
    return authorized;
  }

  function admin(req, res, next) {
    if (!req.session || !req.session.user) return next(new ApiError(401, 'admin_login_required', 'Log in to ztncui first'));
    if (req.method !== 'GET' && !same(req.get('X-Nickname-CSRF'), req.session.nicknameSyncCsrf)) {
      return next(new ApiError(403, 'invalid_csrf', 'Missing or invalid X-Nickname-CSRF header'));
    }
    next();
  }

  async function selectedMember(req) {
    const {networkId, nodeId} = req.params;
    ids(networkId, nodeId);
    await member(networkId, nodeId, true);
    return {networkId, nodeId};
  }

  function openStream(req, res, scope, check, accepts, closeOnRemove) {
    if (streamCount >= 1024 || (streams.get(scope) || 0) >= 4) {
      throw new ApiError(429, 'too_many_streams', 'Close an existing SSE connection before reconnecting');
    }
    streams.set(scope, (streams.get(scope) || 0) + 1);
    streamCount++;
    res.status(200).set({'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', 'Connection': 'keep-alive'});
    res.flushHeaders();
    let closed = false;
    let checking = false;
    let heartbeat;
    const versions = new Map();
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      service.removeListener('nickname', changed);
      service.removeListener('removed', removed);
      const remaining = streams.get(scope) - 1;
      if (remaining) streams.set(scope, remaining); else streams.delete(scope);
      streamCount--;
      res.end();
    }
    function send(event, data) {
      if (closed) return;
      if (res.writableLength > 65536) return close();
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    }
    function changed(record) {
      if (!accepts(record)) return;
      const key = record.networkId + ':' + record.nodeId;
      if (versions.has(key) && versions.get(key) >= record.version) return;
      versions.set(key, record.version);
      send('nickname', record);
    }
    async function validate() {
      if (closed || checking) return;
      checking = true;
      try {
        await check();
        if (!closed) res.write(': heartbeat\n\n');
      } catch (error) {
        send(error.status === 503 ? 'unavailable' : 'removed', {code: error.code || 'membership_required'});
        close();
      } finally { checking = false; }
    }
    function removed(record) {
      if (!accepts(record)) return;
      if (closeOnRemove) { send('removed', {code: 'membership_required'}); close(); }
      else validate();
    }
    service.on('nickname', changed);
    service.on('removed', removed);
    heartbeat = setInterval(validate, options.heartbeatMs || 25000);
    res.on('close', close);
    return {changed, close};
  }

  function errorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') error = new ApiError(400, 'invalid_json', 'Request body must be valid JSON');
    if (error.type === 'entity.too.large') error = new ApiError(413, 'body_too_large', 'Request body is too large');
    const known = error instanceof ApiError;
    if (!known) console.error('Nickname sync error:', error.message);
    res.status(known ? error.status : 500).json(Object.assign({error: {
      code: known ? error.code : 'internal_error', message: known ? error.message : 'Nickname service failed'
    }}, known ? error.extra : null));
  }

  const handleLegacyRename = asyncRoute(async (req, res) => {
    await new Promise((resolve, reject) => admin(req, res, error => error ? reject(error) : resolve()));
    ids(req.params.nwid, req.body.id);
    await member(req.params.nwid, req.body.id, false);
    res.json(await service.update(req.params.nwid, req.body.id, req.body.name, req.body.expectedVersion, 'admin'));
  });

  function install(app) {
    app.use((req, res, next) => {
      if (req.session && req.session.user) {
        if (!req.session.nicknameSyncCsrf) req.session.nicknameSyncCsrf = crypto.randomBytes(32).toString('hex');
        res.locals.nicknameSyncCsrf = req.session.nicknameSyncCsrf;
      }
      next();
    });
    const router = express.Router();
    router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.get('/nickname-sync/health', (req, res) => res.json({status: 'ok', version}));
    const directory = '/networks/:networkId/members';
    router.get(directory + '/nicknames', asyncRoute(async (req, res) => {
      const {networkId} = req.params;
      ids(networkId);
      const members = await service.getMany(networkId, await authorizedMemberIds(networkId));
      const response = {networkId, members};
      const etag = '"members-' + crypto.createHash('sha256').update(JSON.stringify(response)).digest('hex') + '"';
      res.set('ETag', etag);
      if (req.get('If-None-Match') === etag) return res.status(304).end();
      res.json(response);
    }));
    router.get(directory + '/:nodeId/nickname', asyncRoute(async (req, res) => {
      const {networkId, nodeId} = await selectedMember(req);
      const record = await service.get(networkId, nodeId);
      await selectedMember(req);
      const etag = '"nickname-' + record.version + '"';
      res.set('ETag', etag);
      if (req.get('If-None-Match') === etag) return res.status(304).end();
      res.json(record);
    }));
    router.patch(directory + '/:nodeId/nickname', asyncRoute(async (req, res) => {
      const {networkId, nodeId} = await selectedMember(req);
      res.json(await service.update(networkId, nodeId, req.body.nickname, req.body.expectedVersion, 'device', () => selectedMember(req)));
    }));
    router.get(directory + '/:nodeId/events', asyncRoute(async (req, res) => {
      const {networkId, nodeId} = await selectedMember(req);
      const stream = openStream(req, res, 'member:' + networkId + ':' + nodeId, () => selectedMember(req),
        record => record.networkId === networkId && record.nodeId === nodeId, true);
      try { stream.changed(await service.get(networkId, nodeId)); } catch (error) { stream.close(); throw error; }
    }));
    const adminBase = '/admin/networks/:networkId';
    router.use('/admin', admin);
    router.get('/admin/session', (req, res) => res.json({csrfToken: req.session.nicknameSyncCsrf}));
    router.use(adminBase + '/members/:nodeId', asyncRoute(async (req, res, next) => {
      ids(req.params.networkId, req.params.nodeId);
      await member(req.params.networkId, req.params.nodeId, false);
      next();
    }));
    router.get(adminBase + '/members/:nodeId/nickname', asyncRoute(async (req, res) => {
      res.json(await service.get(req.params.networkId, req.params.nodeId));
    }));
    router.patch(adminBase + '/members/:nodeId/nickname', asyncRoute(async (req, res) => {
      res.json(await service.update(req.params.networkId, req.params.nodeId, req.body.nickname, req.body.expectedVersion, 'admin'));
    }));
    router.get(adminBase + '/events', asyncRoute(async (req, res) => {
      ids(req.params.networkId);
      const networkId = req.params.networkId;
      const check = async () => {
        if (!req.session || !req.session.user) throw new ApiError(401, 'admin_login_required', 'Session ended');
        if (req.sessionStore && req.sessionID) {
          const session = await new Promise((resolve, reject) => req.sessionStore.get(req.sessionID,
            (error, value) => error ? reject(error) : resolve(value)));
          if (!session || !session.user) throw new ApiError(401, 'admin_login_required', 'Session ended');
        }
        await zt.network_detail(networkId);
      };
      await check();
      // Save before sending headers; express-session normally saves on response end.
      if (req.session.save) await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
      const stream = openStream(req, res, 'admin:' + req.sessionID + ':' + networkId, check, record => record.networkId === networkId);
      try { (await service.list(networkId)).forEach(stream.changed); } catch (error) { stream.close(); throw error; }
    }));
    app.use('/api/v1', router);
    app.use('/api/v1', errorHandler);
    // The existing admin page keeps its normal session; App routes need no login.
    app.get('/nickname-sync/browser.js', (req, res) => res.sendFile(path.join(__dirname, 'browser.js')));
  }

  // The legacy upstream controller calls this without an Express `next` argument.
  return {service, install, handleLegacyRename: (req, res, next) =>
    handleLegacyRename(req, res, next || (error => errorHandler(error, req, res, () => {})))};
}

let defaultExtension;
function getDefault() {
  if (!defaultExtension) {
    const storage = require('node-persist');
    defaultExtension = createExtension({express: require('express'), zt: require('../controllers/zt'),
      filename: process.env.NICKNAME_STORE_PATH || '/app/config/nickname-sync.json',
      legacyName: nodeId => storage.getItem(nodeId)});
  }
  return defaultExtension;
}

module.exports = {createExtension,
  get service() { return getDefault().service; },
  install: app => getDefault().install(app),
  handleLegacyRename: (req, res, next) => getDefault().handleLegacyRename(req, res, next)};
