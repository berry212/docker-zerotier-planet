#!/usr/bin/env node
'use strict';

// Patch the mounted ztncui sources. Validate all anchors before changing any file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MARKER = 'nickname-sync:v2';
const LEGACY_MARKER = 'nickname-sync:v1';
const INPUT = "              input.form-control.text.nickname-sync-name(type='text' name=member.id value=member.name data-version=member.nicknameVersion maxlength='128')";

function upgradeLegacy(source, relative) {
  let upgraded = once(source, LEGACY_MARKER, MARKER, 'legacy marker');
  if (relative === 'controllers/networkController.js') {
    upgraded = once(upgraded, 'nicknames.revoke(req.params.nwid, member.id, true)',
      'nicknames.remove(req.params.nwid, member.id)', 'legacy member delete');
  } else if (relative === 'views/network_detail.pug') {
    const oldInput = "              input.form-control.nickname-sync-name(type='text' name=member.id value=member.name data-version=member.nicknameVersion maxlength='128')\n" +
      "              button.btn.btn-default.btn-xs.nickname-sync-bind(type='button' style='margin-top: 5px') 绑定 App\n" +
      "              |  \n" +
      "              button.btn.btn-default.btn-xs.nickname-sync-revoke(type='button' style='margin-top: 5px') 撤销绑定\n" +
      "              small.nickname-sync-status(style='display: block' role='status')";
    upgraded = once(upgraded, oldInput, INPUT, 'legacy controls');
    upgraded = once(upgraded, '#nickname-sync-settings(data-network=', '#nickname-sync-settings(style=\'display: none\' data-network=', 'legacy browser settings');
  }
  return upgraded;
}

function once(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error('Unsupported ztncui source: ' + label);
  return source.replace(before, after);
}

function plan(root) {
  const files = ['app.js', 'controllers/networkController.js', 'views/network_detail.pug'];
  return files.map(relative => {
    const filename = path.join(root, relative);
    const original = fs.readFileSync(filename, 'utf8');
    if (original.includes(MARKER)) return {filename, original, patched: original};
    if (original.includes(LEGACY_MARKER)) return {filename, original, patched: upgradeLegacy(original, relative)};
    let patched = original;
    if (relative === 'app.js') {
      patched = once(patched, "app.use('/', index);", "// " + MARKER + "\nrequire('./nickname-sync').install(app);\n\napp.use('/', index);", 'app routes');
    } else if (relative === 'controllers/networkController.js') {
      patched = once(patched, "storage.initSync({dir: 'etc/storage'});", "storage.initSync({dir: 'etc/storage'});\n\n// " + MARKER + "\nconst nicknames = require('../nickname-sync').service;", 'storage init');
      patched = once(patched, 'storage.getItem(id)', 'nicknames.get(nwid, id)', 'member list lookup');
      patched = once(patched, "      }).then(results => results.map(([member, name]) => {\n        member.name = name || '';",
        '      }).then(results => results.map(([member, name]) => {\n        member.name = name.nickname;\n        member.nicknameVersion = name.version;', 'member list name');
      patched = once(patched, 'storage.getItem(memberid)', 'nicknames.get(nwid, memberid)', 'member detail lookup');
      patched = once(patched, "  member.name = name || '';\n  member.peer = peer;",
        '  member.name = name.nickname;\n  member.nicknameVersion = name.version;\n  member.peer = peer;', 'member detail name');
      const start = patched.indexOf('    } else if (req.body.name) {');
      const end = patched.indexOf('  } else { // GET', start);
      if (start < 0 || end < 0) throw new Error('Unsupported ztncui source: member rename branch');
      patched = patched.slice(0, start) + "    } else if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {\n      return require('../nickname-sync').handleLegacyRename(req, res);\n    }\n" + patched.slice(end);
      patched = once(patched, 'storage.removeItem(member.id)', 'nicknames.remove(req.params.nwid, member.id)', 'member delete');
      patched = once(patched, 'name = await storage.getItem(member.id);', 'name = (await nicknames.get(req.params.nwid, member.id)).nickname;', 'delete confirmation');
      patched = patched.replace(/member\.name = await storage\.getItem\(member\.id\) \| '';/g,
        'member.name = (await nicknames.get(req.params.nwid, member.id)).nickname;');
      // There are three `name || ''` statements upstream; the delete page keeps its plain string.
      if (patched.includes('storage.getItem(') || patched.includes('storage.setItem(')) {
        throw new Error('Unsupported ztncui source: unpatched nickname access');
      }
    } else {
      const oldHandler = "        $('.text').on('change', function() {\n          $.post(url, {'id': this.name, 'name': this.value});\n        });";
      patched = once(patched, oldHandler, '        // ' + MARKER + ': names use the versioned admin API.', 'browser rename handler');
      const oldInput = "              input.form-control.text(type='text' name=member.id value=member.name)";
      patched = once(patched, oldInput, INPUT, 'member input');
      patched = once(patched, '  if (members !== undefined)', "  #nickname-sync-settings(style='display: none' data-network=network.nwid data-csrf=nicknameSyncCsrf)\n  script(src='/nickname-sync/browser.js' defer)\n\n  if (members !== undefined)", 'browser settings');
    }
    return {filename, original, patched};
  });
}

function install(root) {
  const changes = plan(root).filter(file => file.original !== file.patched);
  const backup = path.join(root, '.nickname-sync-backups');
  if (changes.length) fs.mkdirSync(backup, {recursive: true, mode: 0o700});
  const written = [];
  try {
    for (const file of changes) {
      const digest = crypto.createHash('sha256').update(file.original).digest('hex').slice(0, 16);
      const target = path.join(backup, path.basename(file.filename) + '.' + digest);
      if (!fs.existsSync(target)) fs.writeFileSync(target, file.original, {mode: 0o600});
      fs.writeFileSync(file.filename + '.nickname-sync.tmp', file.patched);
      fs.renameSync(file.filename + '.nickname-sync.tmp', file.filename);
      written.push(file);
    }
  } catch (error) {
    for (const file of written) fs.writeFileSync(file.filename, file.original);
    throw error;
  }
  return changes.length;
}

if (require.main === module) {
  try {
    const root = process.argv[2] || '/app/ztncui/src';
    console.log('Nickname sync ' + require('./version.json').version + ': patched ' + install(root) + ' ztncui files');
  } catch (error) {
    console.error('Nickname sync installation failed: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = {install, plan};
