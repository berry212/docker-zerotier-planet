# ZeroTier App 昵称同步 API v1

这份文档可以直接交给负责 App 的开发者或 AI。服务部署方法见 [deployment.md](deployment.md)。

## 功能与身份模型

- 昵称属于 `(networkId, nodeId)`，不是操作系统用户名或 ZeroTier 用户账号。同一设备在不同网络可使用不同昵称。
- App 和 ztncui 管理页面读写同一条记录。服务端是最终数据来源，App 本地只做缓存。
- 无须修改 ZeroTierOne、`planet`、`.moon`、`identity.secret` 或 `identity.public`。
- 所有接口使用管理页面所在的服务地址，例如 `https://planet.example.com`。HTTP 监听端口默认是 3443，经反向代理提供 HTTPS；不是文件下载端口 3000。
- App 需要配置 `baseUrl`；不能仅通过 Network ID 或 `planet` 自动发现接口地址。
- 本机 ZeroTier 的认证令牌、服务端控制器令牌、下载密钥都不能用作此 API 的设备凭证。
- 原生桌面/手机 App 可以直接请求。不启用跨站 CORS，也不支持浏览器原生 EventSource 在 URL 中传令牌。

## App 实现顺序

1. 从本机 ZeroTier 获取自己的 10 位十六进制节点 ID，以及所选网络的 16 位 Network ID，统一使用小写。
2. 用户在管理页面对应成员行点击“绑定 App”。成员必须已授权；管理员应先核实该行确实是用户的设备。
3. 用户把一次性绑定码输入 App，App 调用兑换接口。绑定码代表管理员授予的访问权限，不能公开分享。
4. 校验兑换响应里的 `nodeId` 和 `networkId` 与本机所选设备/网络一致。若不一致，不保存凭证，提示用户重新获取正确绑定码。
5. 将设备 `token` 保存在系统凭据存储中，缓存键使用 `(baseUrl, networkId, nodeId)`，不要写进日志或提交仓库。每次重新绑定时，以兑换响应覆盖旧缓存和版本（成员删除后重新加入时版本可能重新开始）。
6. 启动、恢复前台和断线重连时 GET 昵称。在线时建立 SSE，接收管理员或其他会话的修改。
7. 用户主动修改时 PATCH，带当前 `version`；成功后更新缓存。不要周期性上传本地缓存，不要收到推送后再自动回写。
8. 退出前台或退出 App 时按平台需要关闭 SSE；重连使用带随机抖动的指数退避（例如 1～30 秒上限）。
9. `401` 停止自动重试并提示重新绑定；`403` 提示检查网络成员授权；`503` 等待服务恢复；`409` 按下面的冲突规则处理。

App 退出或离线时不会收到推送，下次启动/联网会获取最新值。后台策略由客户端平台决定。

## 1. 健康检查

```http
GET /api/v1/nickname-sync/health
```

无须认证，成功 `200`：

```json
{"status":"ok","version":"1.0.0"}
```

## 2. 兑换一次性绑定码

```http
POST /api/v1/device-bindings/redeem
Content-Type: application/json

{"code":"管理页面生成的64位小写十六进制绑定码"}
```

成功 `201`：

```json
{
  "token": "64位小写十六进制设备凭证",
  "networkId": "00ed8fb92f0e3547",
  "nodeId": "79d0575f06",
  "expiresAt": "2027-01-25T08:00:00.000Z",
  "nickname": {
    "networkId": "00ed8fb92f0e3547",
    "nodeId": "79d0575f06",
    "nickname": "陈的电脑",
    "version": 1,
    "updatedAt": "2026-10-27T08:00:00.000Z",
    "updatedBy": "migration"
  }
}
```

上面的日期仅为格式示例。响应中外层 `nickname` 是完整记录对象。

绑定码有效期 10 分钟，单次使用；同一成员生成新码后旧码作废。兑换新码会撤销该成员之前的设备凭证。设备凭证有效期 90 天，到期需重新绑定。请求超时导致不确定是否兑换成功时，可以尝试使用已收到的凭证；若没有收到凭证，重新生成绑定码，不反复兑换旧码。

## 3. 获取自己的昵称

```http
GET /api/v1/networks/{networkId}/me/nickname
Authorization: Bearer <token>
```

节点身份从 token 确定，调用方不能指定其他节点 ID。成功 `200`：

```json
{
  "networkId": "00ed8fb92f0e3547",
  "nodeId": "79d0575f06",
  "nickname": "陈的电脑",
  "version": 3,
  "updatedAt": "2026-10-27T08:10:00.000Z",
  "updatedBy": "admin"
}
```

字段说明：`updatedBy` 为 `admin`、`device`、`migration`，未设置时为 `null`；空昵称为 `""`，初始版本可为 0，初始 `updatedAt` 可为 `null`。空昵称由 App 自行显示节点 ID 等占位文字，不能把占位文字自动写回服务端。

响应提供 `ETag`，例如 `"nickname-3"`。可选地在下次 GET 添加 `If-None-Match: "nickname-3"`，未变化时返回 `304` 且没有 JSON 响应体。普通 GET 不带该头也完全支持。

```bash
curl 'https://planet.example.com/api/v1/networks/00ed8fb92f0e3547/me/nickname' \
  -H "Authorization: Bearer $DEVICE_TOKEN"
```

## 4. 修改自己的昵称

```http
PATCH /api/v1/networks/{networkId}/me/nickname
Authorization: Bearer <token>
Content-Type: application/json

{"nickname":"陈的笔记本","expectedVersion":3}
```

成功 `200` 返回完整昵称记录，新版本为 4，`updatedBy` 为 `device`。内容与当前值相同则不递增版本。

- 昵称会去除首尾空白并转换为 Unicode NFC。
- 最多 64 个 Unicode 码点，支持中文和 emoji；禁止控制字符及双向文本控制字符。
- 空字符串表示清除昵称。
- `expectedVersion` 必须为非负整数；不能省略、传字符串或自行使用本地时间代替。

```bash
curl -X PATCH 'https://planet.example.com/api/v1/networks/00ed8fb92f0e3547/me/nickname' \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"nickname":"陈的笔记本","expectedVersion":3}'
```

发生并发修改时返回 `409`：

```json
{
  "error": {"code":"version_conflict","message":"Nickname changed; fetch the current value before retrying"},
  "current": {
    "networkId":"00ed8fb92f0e3547",
    "nodeId":"79d0575f06",
    "nickname":"管理员设置的昵称",
    "version":4,
    "updatedAt":"2026-10-27T08:11:00.000Z",
    "updatedBy":"admin"
  }
}
```

App 更新已知服务端值，保留用户未提交的编辑并提示冲突。只有用户确认再次修改后，才以新版本重发；不要静默重试覆盖管理员修改。

## 5. SSE 实时同步

```http
GET /api/v1/networks/{networkId}/me/events
Authorization: Bearer <token>
Accept: text/event-stream
```

成功 `200`，`Content-Type: text/event-stream`。连接建立后先发送当前快照，以后在昵称变化时推送相同格式的记录：

```text
event: nickname
data: {"networkId":"00ed8fb92f0e3547","nodeId":"79d0575f06","nickname":"陈的电脑","version":4,"updatedAt":"2026-10-27T08:11:00.000Z","updatedBy":"admin"}

```

- UTF-8 数据流；按 SSE 规范解析，不能假设一次网络读取恰好是一条消息，也不能逐块单独解码 UTF-8。
- 大约每 25 秒发送 `: heartbeat` 注释，无须展示或回写。服务端同时复查成员授权和凭证有效性。
- 接收到 `nickname` 时，只应用当前网络/节点且版本不低于已知版本的数据。若正在编辑，保留编辑草稿，提交时仍使用编辑开始时的版本，以便发现冲突。
- 断线后重新 GET 并建立 SSE；新连接总会发送最新快照。没有事件历史补发，也不依赖 `Last-Event-ID`。
- 管理员撤销绑定、新绑定替换旧凭证时，发送 `event: revoked` 后断开；成员授权变化最迟在下一次心跳发现。数据为 `{"code":"invalid_token"}` 或 `{"code":"membership_required"}`。停止盲目重连，提示处理授权/重新绑定。
- 控制器临时不可用时，发送 `event: unavailable`（例如 `{"code":"controller_unavailable"}`）后断开，可退避重试。
- 每个设备凭证最多 4 条连接，整个进程最多 1024 条；超出返回 `429`。每个 App 网络实例保持一条连接即可。
- 原生浏览器 `EventSource` 无法设置 `Authorization`。App 应使用支持请求头的 SSE 库，或使用 `fetch` 流式读取；不要把 token 放入 query string。

调试：

```bash
curl -N 'https://planet.example.com/api/v1/networks/00ed8fb92f0e3547/me/events' \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H 'Accept: text/event-stream'
```

## 6. 错误格式

```json
{"error":{"code":"invalid_token","message":"Device token is invalid, revoked or expired"}}
```

| HTTP 状态 | 常见 code | App 行为 |
| --- | --- | --- |
| 400 | `invalid_id` / `invalid_nickname` / `invalid_version` / `invalid_json` | 修正参数，不自动重试 |
| 401 | `invalid_token` / `invalid_binding_code` | 重新绑定或获取新绑定码 |
| 403 | `wrong_network` / `membership_required` | 检查当前网络和成员授权 |
| 409 | `version_conflict` | 使用 `current` 展示最新值，由用户决定是否重改 |
| 413 | `body_too_large` | 缩小请求体 |
| 429 | `too_many_streams` | 关闭多余连接，退避重连 |
| 503 | `controller_unavailable` | 退避重试，不覆盖本地草稿 |

## 管理端接口（App 不应使用）

沿用 ztncui 的管理员登录 Session；写操作还要求 `X-Nickname-CSRF`。登录后 GET `/api/v1/admin/session` 获取 `csrfToken`。权限沿用现有 ztncui 的管理权限模型。

| 方法 | 地址 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/admin/networks/{networkId}/members/{nodeId}/nickname` | 读取成员昵称 |
| PATCH | 同上 | `{"nickname":"...","expectedVersion":3}` |
| POST | `/api/v1/admin/networks/{networkId}/members/{nodeId}/binding-code` | 生成绑定码 |
| DELETE | `/api/v1/admin/networks/{networkId}/members/{nodeId}/binding` | 撤销绑定及未兑换绑定码 |
| GET | `/api/v1/admin/networks/{networkId}/events` | 该网络的昵称 SSE，使用 Session Cookie |

服务端数据保存在 `/app/config/nickname-sync.json`。当前实现是单进程内串行事务、原子文件替换与 fsync，无额外数据库或 npm 运行依赖；适合当前单容器部署。不要让多个进程/容器同时写同一文件。原 `etc/storage` 昵称按需迁移到每个网络，旧存储保留作兼容备份，之后不再作为已迁移记录的写入目标。
