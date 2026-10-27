'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const keyFor = (networkId, nodeId) => networkId + ':' + nodeId;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const secret = () => crypto.randomBytes(32).toString('hex');
const emptyState = () => ({schema: 1, records: {}, codes: {}, tokens: {}, suppressedLegacy: {}});

function decodeLegacy(value) {
  // Old ztncui stores validator.escape() output. Store plain text and escape at rendering.
  const entities = {'&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#x2F;': '/', '&#x60;': '`', '&#x3D;': '='};
  return value.replace(/&(lt|gt|quot|#x27|#x2F|#x60|#x3D);/g, match => entities[match]).replace(/&amp;/g, '&');
}

function validateNickname(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_nickname', 'nickname must be a string');
  const nickname = value.trim().normalize('NFC');
  if (Array.from(nickname).length > 64 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(nickname)) {
    throw new ApiError(400, 'invalid_nickname', 'nickname must contain at most 64 characters and no control characters');
  }
  return nickname;
}

class NicknameStore extends EventEmitter {
  constructor(filename, legacyName) {
    super();
    this.setMaxListeners(0);
    this.filename = filename;
    this.legacyName = legacyName || (async () => undefined);
    this.queue = Promise.resolve();
    fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o700});
    try {
      this.state = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (this.state.schema !== 1 || !this.state.records || !this.state.codes || !this.state.tokens || !this.state.suppressedLegacy) {
        throw new Error('Unsupported nickname store format');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // Never overwrite a corrupt store.
      this.state = emptyState();
    }
  }

  transaction(work) {
    const operation = this.queue.then(async () => {
      const next = JSON.parse(JSON.stringify(this.state));
      const result = await work(next);
      if (JSON.stringify(next) !== JSON.stringify(this.state)) {
        const temporary = this.filename + '.' + secret() + '.tmp';
        let file;
        try {
          file = await fs.promises.open(temporary, 'wx', 0o600);
          await file.writeFile(JSON.stringify(next));
          await file.sync();
          await file.close();
          file = null;
          await fs.promises.rename(temporary, this.filename);
          this.state = next;
          // Persist the rename as well as the contents on Linux filesystems.
          const directory = await fs.promises.open(path.dirname(this.filename), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        } catch (error) {
          if (file) await file.close().catch(() => {});
          await fs.promises.unlink(temporary).catch(() => {});
          throw error;
        }
      }
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async record(state, networkId, nodeId) {
    const key = keyFor(networkId, nodeId);
    if (!state.records[key]) {
      const old = state.suppressedLegacy[key] ? undefined : await this.legacyName(nodeId);
      const nickname = typeof old === 'string' ? decodeLegacy(old) : '';
      state.records[key] = {networkId, nodeId, nickname, version: nickname ? 1 : 0,
        updatedAt: nickname ? new Date().toISOString() : null, updatedBy: nickname ? 'migration' : null};
    }
    return state.records[key];
  }

  async get(networkId, nodeId) {
    await this.queue;
    const existing = this.state.records[keyFor(networkId, nodeId)];
    if (existing) return Object.assign({}, existing);
    return this.transaction(async state => Object.assign({}, await this.record(state, networkId, nodeId)));
  }

  async getMany(networkId, nodeIds) {
    await this.queue;
    if (nodeIds.every(nodeId => this.state.records[keyFor(networkId, nodeId)])) {
      return nodeIds.map(nodeId => Object.assign({}, this.state.records[keyFor(networkId, nodeId)]));
    }
    // Import names for an entire member list with one durable write, including
    // devices that have never opened the App or the ztncui member page.
    return this.transaction(async state => {
      const records = [];
      for (const nodeId of nodeIds) records.push(Object.assign({}, await this.record(state, networkId, nodeId)));
      return records;
    });
  }

  async update(networkId, nodeId, nickname, expectedVersion, updatedBy, token) {
    nickname = validateNickname(nickname);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new ApiError(400, 'invalid_version', 'expectedVersion must be a nonnegative integer');
    }
    const result = await this.transaction(async state => {
      if (updatedBy === 'device') {
        const credential = this.authenticate(token, state);
        if (credential.networkId !== networkId || credential.nodeId !== nodeId) {
          throw new ApiError(403, 'wrong_member', 'Token belongs to another member');
        }
      }
      const current = await this.record(state, networkId, nodeId);
      if (current.version !== expectedVersion) {
        throw new ApiError(409, 'version_conflict', 'Nickname changed; fetch the current value before retrying', {current});
      }
      if (current.nickname === nickname) return {record: Object.assign({}, current), changed: false};
      const record = {networkId, nodeId, nickname, version: current.version + 1,
        updatedAt: new Date().toISOString(), updatedBy};
      state.records[keyFor(networkId, nodeId)] = record;
      return {record, changed: true};
    });
    if (result.changed) this.emit('nickname', result.record);
    return result.record;
  }

  prune(state) {
    const now = Date.now();
    for (const bucket of [state.codes, state.tokens]) {
      for (const key of Object.keys(bucket)) if (bucket[key].expiresAt <= now) delete bucket[key];
    }
  }

  createCode(networkId, nodeId) {
    const code = secret();
    return this.transaction(state => {
      this.prune(state);
      for (const key of Object.keys(state.codes)) {
        const entry = state.codes[key];
        if (entry.networkId === networkId && entry.nodeId === nodeId) delete state.codes[key];
      }
      const expiresAt = Date.now() + 10 * 60 * 1000;
      state.codes[hash(code)] = {networkId, nodeId, expiresAt};
      return {code, networkId, nodeId, expiresAt: new Date(expiresAt).toISOString()};
    });
  }

  codeInfo(code) {
    const entry = typeof code === 'string' && /^[a-f0-9]{64}$/.test(code) && this.state.codes[hash(code)];
    if (!entry || entry.expiresAt <= Date.now()) throw new ApiError(401, 'invalid_binding_code', 'Binding code is invalid or expired');
    return Object.assign({}, entry);
  }

  async redeem(code) {
    const token = secret();
    const result = await this.transaction(state => {
      this.prune(state);
      const entry = typeof code === 'string' && state.codes[hash(code)];
      if (!entry) throw new ApiError(401, 'invalid_binding_code', 'Binding code is invalid or expired');
      delete state.codes[hash(code)];
      // A new binding replaces the old device credential.
      for (const key of Object.keys(state.tokens)) {
        if (state.tokens[key].networkId === entry.networkId && state.tokens[key].nodeId === entry.nodeId) delete state.tokens[key];
      }
      const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
      state.tokens[hash(token)] = {networkId: entry.networkId, nodeId: entry.nodeId, expiresAt};
      return {token, networkId: entry.networkId, nodeId: entry.nodeId, expiresAt: new Date(expiresAt).toISOString()};
    });
    this.emit('binding', {networkId: result.networkId, nodeId: result.nodeId});
    return result;
  }

  authenticate(token, state) {
    state = state || this.state;
    const entry = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && state.tokens[hash(token)];
    if (!entry || entry.expiresAt <= Date.now()) throw new ApiError(401, 'invalid_token', 'Device token is invalid, revoked or expired');
    return Object.assign({}, entry);
  }

  async revoke(networkId, nodeId, remove) {
    await this.transaction(state => {
      for (const bucket of [state.codes, state.tokens]) {
        for (const key of Object.keys(bucket)) {
          if (bucket[key].networkId === networkId && bucket[key].nodeId === nodeId) delete bucket[key];
        }
      }
      if (remove) {
        delete state.records[keyFor(networkId, nodeId)];
        state.suppressedLegacy[keyFor(networkId, nodeId)] = true;
      }
    });
    this.emit('binding', {networkId, nodeId});
    return '';
  }

  async list(networkId) {
    await this.queue;
    return Object.values(this.state.records).filter(record => record.networkId === networkId).map(record => Object.assign({}, record));
  }
}

module.exports = {NicknameStore, ApiError, validateNickname};
