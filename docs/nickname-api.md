# ZeroTier App 昵称双向同步 API（服务版本 2.0.0）

可直接把本文交给 App 开发者或 AI。部署见 [deployment.md](deployment.md)。

## 功能与接入方式

- App 昵称和管理页面原有 **Member name** 是同一条数据，按 `(networkId, nodeId)` 保存。
- 客户端接口**免鉴权**：不需要登录、Authorization、设备凭证、绑定码或兑换操作。客户端从本机 ZeroTier 读取 Network ID 和 Node ID 后直接调用。
- 管理员继续在原有 Member name 输入框修改名字；页面没有新增按钮、表单、昵称状态栏或绑定入口。原管理页面登录保持原样。
- 服务端检查 URL 指定的节点确实存在且 `authorized=true`，然后允许读取、修改和订阅。这里检查的是目标节点的入网状态，**不证明 HTTP 请求来自该节点**；知道 ID 且能访问 API 的调用者同样能修改昵称。如果希望访问范围仅限已入网设备，应通过 ZeroTier 网络地址和防火墙限制接口来源。
- 不修改 ZeroTier 协议、`planet`、`.moon` 或设备身份文件。客户端另外配置服务端 `baseUrl`，例如 `https://planet.example.com` 或服务器可达的 ZeroTier 地址；不能仅凭 Network ID 自动发现 HTTP 地址。
- HTTP 端口沿用管理页面，默认 `3443`，不是文件下载端口 `3000`。使用 HTTPS 域名时填反向代理的地址。

## 客户端实现顺序

1. 获取本机的 10 位小写十六进制 `nodeId` 和所选网络的 16 位 `networkId`。
2. 启动、切回前台或联网恢复时 GET 昵称，保存服务端返回的 `nickname` 和 `version`。缓存按 `(baseUrl, networkId, nodeId)` 区分。
3. 建立该节点的 SSE 连接。管理员修改 Member name 后，收到 `nickname` 事件，更新 App 显示和本地缓存。
4. 用户主动修改昵称时 PATCH，携带已知 `version` 作为 `expectedVersion`。成功响应更新本地值，服务端同时通知管理页面，页面原输入框实时更新。
5. **不要定时上传本地缓存，不要收到 SSE 后再次回写。**自动同步只读；只有用户主动编辑时提交，避免互相覆盖和循环更新。
6. 收到 `409` 时保留用户草稿，显示响应里的最新 `current`，由用户确认是否以新版本重提；不能自动覆盖管理员的新修改。
7. 成员列表显示其他设备名字时，批量 GET 成员昵称，按 `nodeId` 匹配设备。空昵称以节点 ID 作为显示后备值，不把后备文字写回服务端。

App 离线/关闭期间不接收推送；下次启动或重连获取最新状态。会员移除后重新加入时，清理该节点旧版本缓存并重新 GET。

## 1. 健康检查

```http
GET /api/v1/nickname-sync/health
```

成功 `200`：

```json
{"status":"ok","version":"2.0.0"}
```

## 2. 获取指定成员昵称

```http
GET /api/v1/networks/{networkId}/members/{nodeId}/nickname
```

**无认证请求头。**成功 `200`：

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

- `updatedBy` 为 `admin`、`device`、`migration` 或 `null`。`device` 表示从客户端接口提交，不是设备身份验证结果。
- 未设置昵称时返回 `nickname: ""`、`version: 0`、`updatedAt: null`、`updatedBy: null`。
- 可保存响应 `ETag`，例如 `"nickname-3"`，下次 GET 传 `If-None-Match: "nickname-3"`；未变化返回 `304`，无 JSON 响应体。

```bash
curl 'https://planet.example.com/api/v1/networks/00ed8fb92f0e3547/members/79d0575f06/nickname'
```

## 3. 修改指定成员昵称

```http
PATCH /api/v1/networks/{networkId}/members/{nodeId}/nickname
Content-Type: application/json

{"nickname":"陈的笔记本","expectedVersion":3}
```

成功 `200` 返回完整昵称记录，新版本为 4，`updatedBy` 为 `device`。保存后会发送 SSE 事件，管理页面自动更新。内容与当前值相同不递增版本。

- `expectedVersion` 是 GET/SSE 返回的版本，必须为非负整数，不能省略、传字符串或用时间戳代替。它用于防止旧缓存覆盖新昵称，不是认证凭据。
- 昵称去掉首尾空白并转换为 Unicode NFC，最多 64 个 Unicode 码点，支持中文和 emoji，禁止控制字符和双向文本控制字符。
- `nickname: ""` 表示清除昵称。

```bash
curl -X PATCH 'https://planet.example.com/api/v1/networks/00ed8fb92f0e3547/members/79d0575f06/nickname' \
  -H 'Content-Type: application/json' \
  --data '{"nickname":"陈的笔记本","expectedVersion":3}'
```

管理员已修改过名字时，旧请求返回 `409`：

```json
{
  "error": {"code":"version_conflict","message":"Nickname changed; fetch the current value before retrying"},
  "current": {
    "networkId":"00ed8fb92f0e3547",
    "nodeId":"79d0575f06",
    "nickname":"管理员的新名字",
    "version":4,
    "updatedAt":"2026-10-27T08:11:00.000Z",
    "updatedBy":"admin"
  }
}
```

## 4. SSE 接收管理员改名

```http
GET /api/v1/networks/{networkId}/members/{nodeId}/events
Accept: text/event-stream
```

无需 Authorization、Cookie 或兑换。连接建立后先发送当前快照，以后在名字改变时推送完整记录：

```text
event: nickname
data: {"networkId":"00ed8fb92f0e3547","nodeId":"79d0575f06","nickname":"陈的电脑","version":4,"updatedAt":"2026-10-27T08:11:00.000Z","updatedBy":"admin"}

```

- 支持原生 `EventSource`、SSE 库或原生 HTTP 流读取；网页跨域访问仍需同源代理或客户端原生网络层，服务器不启用跨域 CORS。
- 按 SSE 协议和 UTF-8 流解析；一次网络读取可能只包含半条消息或半个中文字符。
- 大约每 25 秒发送 `: heartbeat` 注释，并复查目标成员是否仍授权。等待时不持续占用 CPU。
- 授权取消、成员删除时，发送 `event: removed`，数据为 `{"code":"membership_required"}`，随后断开。停止重连，提示检查成员授权。管理页面删除成员时会主动关闭其连接；其他控制器变更最迟在下一次心跳发现。
- 控制器不可用时，发送 `event: unavailable`（例如 `{"code":"controller_unavailable"}`）后断开，可指数退避重试。
- 断线后重新 GET 并建立 SSE，新连接总会发送最新快照，不提供事件历史补发，也不依赖 `Last-Event-ID`。
- 只订阅 URL 指定成员的昵称。其他成员列表是批量 GET 的快照，在成员列表刷新时重新获取。
- 每个网络/节点最多 4 条 SSE 连接，整个进程最多 1024 条。退出 App/页面时关闭连接，重连采用带随机抖动的指数退避。

```bash
curl -N 'https://planet.example.com/api/v1/networks/00ed8fb92f0e3547/members/79d0575f06/events'
```

## 5. 批量查询网络成员昵称

```http
GET /api/v1/networks/{networkId}/members/nicknames
```

无需认证。成功 `200`：

```json
{
  "networkId":"00ed8fb92f0e3547",
  "members":[
    {"networkId":"00ed8fb92f0e3547","nodeId":"79d0575f06","nickname":"陈的电脑","version":4,"updatedAt":"2026-10-27T08:11:00.000Z","updatedBy":"admin"},
    {"networkId":"00ed8fb92f0e3547","nodeId":"d484a54ba7","nickname":"","version":0,"updatedAt":null,"updatedBy":null}
  ]
}
```

列表包括指定网络当前已授权的成员和离线设备，按 `nodeId` 排序；未授权、已删除、其他网络及仅残留在存储中的记录不返回。旧 ztncui 名字自动按需迁移，不要求管理员先打开页面。接口不提供 IP、在线状态、登录账号信息；用 `nodeId` 与本地成员/peer 数据关联。

支持 `ETag` / `If-None-Match`，未变化返回 `304`；昵称、成员授权或成员列表变化时 ETag 会变化。

## 错误格式

```json
{"error":{"code":"membership_required","message":"Device must be an authorized member of this network"}}
```

| 状态 | code | 处理 |
| --- | --- | --- |
| 400 | `invalid_id` / `invalid_nickname` / `invalid_version` / `invalid_json` | 修正参数 |
| 403 | `membership_required` | URL 指定成员不存在、已删除或未授权，检查 Network ID 和 Node ID |
| 409 | `version_conflict` | 使用 `current` 展示最新值，用户确认后重提 |
| 413 | `body_too_large` | 缩小请求体 |
| 429 | `too_many_streams` | 关闭多余 SSE 连接，退避重试 |
| 503 | `controller_unavailable` | 等待控制器恢复后重试，保留草稿 |

## 管理页面与旧版本升级

- 管理页面只保留原有 Member name 输入框。后台沿用原登录 Session，写操作使用隐藏的 CSRF 值；这些不是客户端接口的接入条件，不增加管理员交互步骤。
- 管理端内部接口仍为 `/api/v1/admin/networks/{networkId}/members/{nodeId}/nickname`（GET/PATCH）和 `/api/v1/admin/networks/{networkId}/events`（SSE），供原页面使用。
- 版本 2.0.0 移除绑定码生成/兑换/撤销接口，以及依赖设备凭证的 `/me/nickname`、`/me/events`。客户端改用本文带 `nodeId` 的地址，不发送 token。
- `./deploy.sh --update` 会迁移已打过 v1 补丁的页面，去掉旧按钮和状态栏，保留现有名字、版本和管理员登录信息。旧绑定数据会清空；数据文件保留兼容结构，便于代码回退。
- `/app/config/nickname-sync.json` 使用单进程串行写入、原子文件替换与 fsync；不增加 npm 运行依赖。不要让多个进程/容器同时写同一文件。
