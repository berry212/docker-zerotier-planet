# 在目标服务器部署昵称同步

开发电脑不需要运行 ZeroTier 服务。本次改动支持直接更新目标服务器上的现有容器，不需要重编译 ZeroTier，也不需要重新分发 `planet`。

## 1. 从此 fork 部署

昵称同步功能位于 `https://github.com/berry212/docker-zerotier-planet.git`，不是原上游仓库。目标服务器已安装 Docker 时，首次部署可以直接执行：

```bash
git clone https://github.com/berry212/docker-zerotier-planet.git
cd docker-zerotier-planet
./deploy.sh --install
```

服务器已有原项目时，先备份数据，再在**原项目目录**添加此 fork 并更新：

```bash
git remote add berry212 https://github.com/berry212/docker-zerotier-planet.git
git fetch berry212
git merge --ff-only berry212/master
./deploy.sh
```

如果已经存在 `berry212` remote，无须重复添加。若有本地改动或提交，Git 会拒绝覆盖或快进；先处理自己的改动，不要强制重置。后续更新使用 `git fetch berry212 && git merge --ff-only berry212/master`，再运行 `./deploy.sh`。

## 通过代码包传输（可选）

如果使用本次提供的发布包，在开发电脑执行（替换服务器地址和用户名）：

```bash
scp dist/zerotier-nickname-sync-2.0.0.tar.gz root@SERVER_IP:/tmp/
```

发布包包含代码和文档，不包含开发依赖、Git 历史、任何 `data/` 或凭据。

已有部署应使用原来的项目目录，保留原有 `data/`；不要用开发电脑的目录覆盖服务器数据。

## 2A. 服务器已有部署

登录目标服务器，进入**原来的项目目录**。下面以 `/opt/docker-zerotier-planet` 为例，替换成实际目录：

```bash
ssh root@SERVER_IP
cd /opt/docker-zerotier-planet
docker ps -a --filter name=myztplanet
```

建议先备份已有数据。需要完整一致的备份时，暂停容器后备份，再启动：

```bash
docker stop myztplanet
tar -czf "../zerotier-backup-$(date +%Y%m%d-%H%M%S).tar.gz" data/zerotier
docker start myztplanet
```

解压代码包到当前目录，然后执行：

```bash
tar -xzf /tmp/zerotier-nickname-sync-2.0.0.tar.gz --strip-components=1
chmod +x deploy.sh
./deploy.sh
```

无参数执行 `deploy.sh`，检测到已有 `myztplanet` 容器后，会自动：

1. 备份将修改的管理端文件和已有扩展代码。
2. 将本地 `patch/nickname-sync/` 安装到容器挂载的 ztncui 源码目录。
3. 校验上游代码结构并应用补丁；不支持的版本会拒绝安装，不猜测修改位置。
4. 重启容器，检查昵称 API 的健康状态；失败时尝试恢复先前代码并重启。

会有一次短暂的容器重启。保留节点身份、签名密钥、网络数据、管理密码、已有挂载和 Docker 运行参数；不会拉取新基础镜像。更新过程自动备份的是管理端代码，不是整个 ZeroTier 数据目录。

显式执行相同更新：

```bash
./deploy.sh --update
```

自定义容器名称时：

```bash
CONTAINER_NAME=你的容器名称 ./deploy.sh --update
```

原运维菜单使用 `./deploy.sh --menu`；菜单“更新”仍可拉取基础镜像，同时安装本地昵称扩展。脚本不会自动从 Git 下载新代码，后续更新需先同步代码，再运行脚本。

## 2B. 服务器尚未部署

目标环境：有公网 IP 的 Linux 服务器、Docker、Bash、Git/Curl 等原项目依赖。无需在宿主机另装 Node.js，扩展使用容器已有的 Node.js 和 Express。

```bash
ssh root@SERVER_IP
mkdir -p /opt
tar -xzf /tmp/zerotier-nickname-sync-2.0.0.tar.gz -C /opt
cd /opt/docker-zerotier-planet
chmod +x deploy.sh
./deploy.sh --install
```

按提示填写公网 IP 和端口。脚本使用原项目镜像安装 ZeroTier，再自动装入本地昵称扩展。首次登录默认 `admin / password`，立即修改密码。

数据默认保存在脚本所在目录的 `data/zerotier`。需要其他位置时使用绝对路径：

```bash
ZEROTIER_DATA_PATH=/srv/zerotier ./deploy.sh --install
```

如果已有数据但容器已删除，确保代码放回原项目目录（或正确设置 `ZEROTIER_DATA_PATH`），再运行 `--install`；检测到已有 `one/` 数据时使用 `config/` 恢复容器，不重新生成身份。备份不能省略。

## 3. 验证双向同步

使用实际管理端口，默认 3443：

```bash
curl --fail http://127.0.0.1:3443/api/v1/nickname-sync/health
docker logs --tail 100 myztplanet
```

预期健康响应：

```json
{"status":"ok","version":"2.0.0"}
```

打开管理页面并强制刷新，继续使用原有 **Member name** 输入框。没有新增按钮；如果旧版本曾显示绑定/撤销按钮，本次更新会自动移除。

1. 确认设备 Member ID，并勾选 Authorized。
2. App 配置服务端地址和自己的 Network ID / Node ID，直接 GET `/api/v1/networks/{networkId}/members/{nodeId}/nickname`，不需要任何绑定、兑换或认证请求头。
3. App 建立 `/api/v1/networks/{networkId}/members/{nodeId}/events` SSE 连接；在管理页面修改 Member name，检查 App 收到更新。
4. App PATCH 昵称，提交新名字和刚读取的版本，检查管理页面原输入框实时更新。

App 接口完整文档：[nickname-api.md](nickname-api.md)。

2.0.0 移除旧版本的设备凭证、兑换流程及 `/me/` 接口，改用明确包含 Node ID 的免鉴权接口。已有部署先同步本版本代码，再运行 `./deploy.sh --update`；保留现有昵称及版本，不需要重编译镜像或重生成 Planet。确认健康检查显示 2.0.0，否则新代码尚未安装。

## 4. 为 App 提供 HTTPS 和 SSE

昵称接口使用现有管理端口，不新增端口。公网 App 使用前，应通过域名和有效证书提供 HTTPS。以下 Nginx 配置片段合并到已有 HTTPS `server` 中（证书与域名按实际配置）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3443;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 90s;
}
```

App 的 `baseUrl` 填 `https://你的域名` 或服务器可达的 ZeroTier 地址。管理端口可限制为本机反向代理或受信任来源。昵称接口免鉴权，若仅允许入网设备访问，需要让服务器加入该网络并通过防火墙限制来源。SSE 路径与其他 API 一起代理，不能仅开放 GET 而拦截 PATCH 和 events。

## 数据和回退

- 新数据文件：容器内 `/app/config/nickname-sync.json`，默认宿主机 `data/zerotier/config/nickname-sync.json`。保存昵称、版本和旧数据迁移状态，应与整个 `data/zerotier/` 一起备份。旧绑定数据会清空，磁盘结构保持兼容，代码回退不会因数据格式改变而无法启动。
- 升级前代码包：容器内 `/app/config/nickname-sync-backups/*.tar.gz`，默认宿主机 `data/zerotier/config/nickname-sync-backups/`。
- 初次补丁的原文件另存于 ztncui `src/.nickname-sync-backups/`。
- 自动健康检查失败会尝试回退代码；仍失败时查看容器日志。不要删除 `one/` 或重置节点身份来解决昵称接口问题。
- 使用本仓库新构建的镜像时，启动流程也会为首次部署安装扩展；已有扩展以持久化目录版本为准，更新扩展仍运行 `deploy.sh`。
- 当前开发环境没有可用 Docker，已运行 HTTP/SSE 集成测试与实际上游源码补丁校验；最终容器运行与公网 HTTPS 连通性需在目标服务器按上述步骤验证。

## 开发验证

测试需要开发电脑 Node.js 18+，不需要部署 ZeroTier：

```bash
npm ci --prefix tests --ignore-scripts
npm test --prefix tests
bash -n deploy.sh
```
