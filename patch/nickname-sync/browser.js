/* global jQuery */
'use strict';

(function ($) {
  $(function () {
    var settings = document.getElementById('nickname-sync-settings');
    if (!settings) return;
    var networkId = settings.getAttribute('data-network');
    var csrf = settings.getAttribute('data-csrf');
    var base = '/api/v1/admin/networks/' + networkId;
    var rows = new Map();
    var pending = new Map();
    $('input.nickname-sync-name').each(function () { rows.set(this.name, this); });

    function status(input, message, failed) {
      $(input).closest('td').find('.nickname-sync-status').text(message).css('color', failed ? '#b52b27' : '#555');
    }
    function receive(record) {
      var input = rows.get(record.nodeId);
      if (!input) return;
      if (Number(input.getAttribute('data-version')) > record.version) return;
      if (document.activeElement === input || input.disabled || input.nicknameSyncDirty) {
        var previous = pending.get(record.nodeId);
        if (!previous || previous.version <= record.version) pending.set(record.nodeId, record);
        return;
      }
      pending.delete(record.nodeId);
      input.value = record.nickname;
      input.setAttribute('data-version', record.version);
    }
    function flush(input) {
      var record = pending.get(input.name);
      if (record) {
        if (record.version < Number(input.getAttribute('data-version'))) pending.delete(input.name);
        else receive(record);
      }
    }
    function request(input, method, suffix, body) {
      return $.ajax({url: base + '/members/' + input.name + suffix, method: method,
        headers: {'X-Nickname-CSRF': csrf}, contentType: 'application/json',
        data: body === undefined ? undefined : JSON.stringify(body)});
    }
    $('input.nickname-sync-name').on('input', function () { this.nicknameSyncDirty = true; })
      .on('blur', function () { var input = this; setTimeout(function () { flush(input); }, 0); })
      .on('change', function () {
      var input = this;
      var nickname = input.value;
      input.disabled = true;
      status(input, '正在保存…');
      request(input, 'PATCH', '/nickname', {nickname: nickname, expectedVersion: Number(input.getAttribute('data-version'))})
        .done(function (record) {
          input.nicknameSyncDirty = false;
          input.value = record.nickname;
          input.setAttribute('data-version', record.version);
          status(input, '已同步');
        }).fail(function (xhr) {
          var body = xhr.responseJSON || {};
          if (xhr.status === 409 && body.current) {
            input.nicknameSyncDirty = false;
            input.value = body.current.nickname;
            input.setAttribute('data-version', body.current.version);
            status(input, '昵称已被其他端修改，已显示最新值，请重新编辑。', true);
          } else {
            status(input, (body.error && body.error.message) || '保存失败，请检查连接后重新编辑。', true);
          }
        }).always(function () { input.disabled = false; flush(input); });
    });
    $('.nickname-sync-bind').on('click', function () {
      var input = $(this).closest('td').find('input')[0];
      request(input, 'POST', '/binding-code', {}).done(function (binding) {
        // A prompt keeps the one-time secret out of the DOM and makes it easy to copy.
        window.prompt('复制绑定码到 App（10 分钟内有效，仅使用一次；请确认该成员是你的设备）：', binding.code);
        status(input, '绑定码已生成，10 分钟内有效。');
      }).fail(function (xhr) {
        status(input, (xhr.responseJSON && xhr.responseJSON.error.message) || '生成绑定码失败，请确认成员已授权。', true);
      });
    });
    $('.nickname-sync-revoke').on('click', function () {
      var input = $(this).closest('td').find('input')[0];
      if (!window.confirm('撤销该设备的昵称同步凭证？重新连接需要生成新的绑定码。')) return;
      request(input, 'DELETE', '/binding').done(function () { status(input, 'App 绑定已撤销。'); })
        .fail(function () { status(input, '撤销失败，请重试。', true); });
    });
    if (window.EventSource) {
      var source = new EventSource(base + '/events');
      source.addEventListener('nickname', function (event) { receive(JSON.parse(event.data)); });
      source.addEventListener('revoked', function () { source.close(); });
      window.addEventListener('pagehide', function () { source.close(); });
      // A bfcache restore must reconnect instead of showing a stale, disconnected page.
      window.addEventListener('pageshow', function (event) { if (event.persisted) window.location.reload(); });
    }
  });
})(jQuery);
