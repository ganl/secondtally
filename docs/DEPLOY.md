# 部署指南

自部署的同步服务端 + 三端产物构建。本文只覆盖生产环境真正需要动手的部分。

## 先理解一件事:服务器存的是什么

这是部署前必须搞清楚的,否则容易做出错误的安全决策。

| 内容 | 是否在服务器上 | 说明 |
| --- | --- | --- |
| 主密码 | 否 | 只存在于用户设备内存,永不上传 |
| TOTP 种子 | 否 | 加密后才上传 |
| 账号名、服务名、备注 | 否 | 同上,都在密文里 |
| 恢复码 | 否(明文) | 只上传逐条加盐后的哈希 |
| AES-256-GCM 密文 | 是 | 服务端无法解读 |
| 同步账号的用户名 + 口令哈希 | 是 | 口令只用于 HTTP 层认证 |
| 访问令牌 | 是(短期) | 决定把哪份密文发给谁 |

**推论**:服务器被完全入侵(拿到数据库文件)也无法读取任何 TOTP 种子。
但攻击者可以删除数据、拒绝服务、或用伪造数据覆盖。
所以备份与可用性仍然是你的责任,机密性不是。

服务端的 `TWOFA_TOKEN_SECRET` 泄露后果:攻击者能伪造访问令牌、
拉取任意用户的密文离线研究、或越权写入。**无法解密**,但必须保密。

## 一、服务端部署

### 1. 构建

服务端是 **Go 实现**,构建产物是单个静态二进制,目标机器不需要装 Node。

```bash
git clone <你的仓库> /opt/twofa
cd /opt/twofa

# 依赖:Go 1.22+ 与 Node 20+。
# Node 只用于构建前端产物,服务端运行期不依赖它。
npm ci
npm run build          # core / web / ext / server 全部构建
```

产物位置:

| 路径 | 说明 |
| --- | --- |
| `server-go/dist/twofa-server` | **服务端二进制**(约 17 MB,Linux 版需自行 `GOOS=linux go build`) |
| `apps/web/dist/` | Web 端静态文件 |
| `apps/extension/dist/` | 浏览器扩展(手动加载,不部署) |
| `apps/miniprogram/` | 微信小程序(用开发者工具打开) |

只构建服务端:

```bash
npm run build:server     # 等价于 cd server-go && go build -o dist/twofa-server ./cmd/twofa-server
npm run test:server      # 跑 Go 测试
```

> PostgreSQL 的集成测试默认**跳过**(多数开发机没装 PG),
> 设置连接串后才会真正执行:
> ```bash
> # 一次性起个本地实例
> docker run -d --name twofa-pg -e POSTGRES_PASSWORD=postgres \
>   -e POSTGRES_DB=twofa_test -p 5433:5432 postgres:16
>
> TWOFA_TEST_POSTGRES="postgres://postgres:postgres@127.0.0.1:5433/twofa_test?sslmode=disable" \
>   npm run test:server
> ```
> 不这样设计的话,克隆下来没装数据库就跑不了测试。

> **国内网络注意**:`proxy.golang.org` 直连通常返回 502,先执行:
> `go env -w GOPROXY=https://goproxy.cn,https://mirrors.aliyun.com/goproxy/,direct`

> **交叉编译**:部署到 Linux 服务器时在本地构建即可,
> `GOOS=linux GOARCH=amd64 go build -o dist/twofa-server ./cmd/twofa-server`。
> 项目使用纯 Go 驱动(`modernc.org/sqlite` 与 `github.com/lib/pq`),
> **两种数据库都不需要 CGO**,交叉编译不需要额外的 C 工具链。

### 2. 选数据库

服务端支持 SQLite 与 PostgreSQL,由 `TWOFA_DB_DRIVER` 决定。

| | SQLite | PostgreSQL |
| --- | --- | --- |
| 定位 | 本地开发、单机小规模部署 | **实际部署首选** |
| 运维成本 | 单文件,零运维 | 需独立实例 |
| 写并发 | 整库串行写 | 行级锁,并发写 |
| 多实例 | 不支持(文件锁冲突) | 支持 |
| 额外依赖 | 无 | `TWOFA_DATABASE_URL` |

**默认值的选取规则**:`TWOFA_ENV=production` 时默认 `postgres`,
其余环境默认 `sqlite`。但**显式设置始终优先**——
生产环境用 SQLite 是真实存在的合理场景(单机、不追求多实例),
程序只负责把默认选对,不替你做这个决定。

配置示例:

```ini
# 生产环境:PostgreSQL(推荐)
TWOFA_ENV=production
TWOFA_DB_DRIVER=postgres
TWOFA_DATABASE_URL=postgres://twofa:密码@127.0.0.1:5432/twofa?sslmode=require
```

```ini
# 单机小规模:SQLite
TWOFA_ENV=production
TWOFA_DB_DRIVER=sqlite
TWOFA_DATA_DIR=/var/lib/twofa
```

建库与最小权限账号:

```sql
-- 用 postgres 管理员账号执行
CREATE ROLE twofa LOGIN PASSWORD '换成随机长密码';
CREATE DATABASE twofa OWNER twofa;
-- 若应用与数据库不在同一台机器,再限制来源 IP:
-- ALTER ROLE twofa CONNECTION LIMIT 20;
```

`sslmode` 取值:

| 值 | 用途 |
| --- | --- |
| `require` | 本机或内网自建实例(推荐,不必配证书) |
| `disable` | **仅限本机开发调试** |
| `verify-full` | 生产公网连接,校验服务端证书 |

建表由服务启动时自动完成(`CREATE TABLE IF NOT EXISTS`),
首次启动连接不上会直接退出并打印错误,不会静默降级。

> **从 SQLite 迁移到 PostgreSQL**:密文是自描述的加密信封,
> 与存储层无关,两个库的 `envelope` 列内容完全一致。迁移就是把
> `vaults` 与 `sync_log` 两张表的数据搬过去,无需解密。
> 记得同时把 `TWOFA_TOKEN_SECRET` 保持一致,否则已签发的令牌全部失效。

### 3. 配置

```bash
cp .env.example .env
openssl rand -hex 32      # 生成令牌密钥
```

编辑 `.env`,生产环境至少改这几项:

```ini
TWOFA_ENV=production
HOST=127.0.0.1              # 只监听回环,由反代对外
TWOFA_TOKEN_SECRET=<上面生成的值>
TWOFA_ALLOWED_ORIGINS=https://2fa.example.com

# 数据库二选一:
TWOFA_DB_DRIVER=postgres
TWOFA_DATABASE_URL=postgres://twofa:密码@127.0.0.1:5432/twofa?sslmode=require
# TWOFA_DATA_DIR=/var/lib/twofa   # 仅 sqlite 模式需要
```

`TWOFA_ALLOWED_ORIGINS` 必须写你的真实站点来源,不能留 `*`。
生产环境若留通配,任何网站都能读取用户的同步接口。

> `NODE_ENV` 作为兼容项保留(等价于 `TWOFA_ENV=production`),
> 便于迁移期同一份 `.env` 供新旧两版共用。

**启动即校验**——以下情况服务会直接退出而不是降级运行:

| 情况 | 提示信息 |
| --- | --- |
| 缺 `TWOFA_TOKEN_SECRET` | 生产环境必须设置,附生成命令 |
| 用开发默认密钥 | 生产环境拒绝使用开发默认密钥 |
| 密钥短于 32 字符 | 至少需要 32 个字符 |
| CORS 含 `*` | 不允许通配符,请配置具体来源 |
| CORS 无任何 `https://` 来源 | 生产环境要求 https |
| 选了 `postgres` 但没给连接串 | 必须设置 `TWOFA_DATABASE_URL` |
| `TWOFA_DB_DRIVER` 不是 sqlite/postgres | 报错并列出可选值 |
| PostgreSQL 连不上 | 打印底层错误后退出,不静默改用本地文件 |
| `PORT` 不在 1–65535 | 端口非法 |
| `TWOFA_TOKEN_TTL` 越界 | 必须在 60 到 2592000 秒之间 |

> 最后一条尤其重要:数据库连不上时**绝不能**回落到 SQLite。
> 那会把生产数据写进一个没人备份的本地文件,故障从"连不上库"
> 悄悄变成"数据丢了"。

完整配置项见 `.env.example` 内的注释。

### 4. systemd 服务

`/etc/systemd/system/twofa.service`:

```ini
[Unit]
Description=Aegis 2FA Sync Server
After=network.target

[Service]
Type=simple
User=twofa
Group=twofa
WorkingDirectory=/opt/twofa
ExecStart=/opt/twofa/server-go/dist/twofa-server
Restart=always
RestartSec=3

# 收到 SIGTERM 后给在途请求 10 秒完成再退出,
# 避免用户在同步写入中途被断开而误以为失败。
KillSignal=SIGTERM
TimeoutStopSec=15

# 安全加固:服务只需要读代码和写数据目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/twofa
ProtectKernelTunables=true
ProtectControlGroups=true
# Go 运行时需要网络与文件系统,故未限制 AF_UNIX 之外更多族;
# 若部署环境不需要 IPv6,可从下表去掉 AF_INET6。
RestrictAddressFamilies=AF_INET AF_INET6

EnvironmentFile=/opt/twofa/.env

[Install]
WantedBy=multi-user.target
```

> `ReadWritePaths=/var/lib/twofa` 在两种数据库模式下都要保留:
> 即使走 PostgreSQL,`credentials.json` 仍写在这个目录里。
> 去掉它服务会因无法写凭据而启动失败。

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin twofa
sudo mkdir -p /var/lib/twofa && sudo chown twofa:twofa /var/lib/twofa
sudo systemctl daemon-reload
sudo systemctl enable --now twofa
sudo systemctl status twofa
```

> **迁移提示**:旧的 Node 版数据目录是 `server/data/`,新版是 `server-go/data/`(默认值)。
> 两者文件名相同(`vaults.db` 与 `credentials.json`),**可直接复制**——
> scrypt 参数、令牌格式、数据库 schema 都保持了向后兼容。
> 但 `TWOFA_TOKEN_SECRET` 必须一致,否则已签发的令牌全部失效,用户需重新登录。

### 5. Nginx 反代

```nginx
server {
    listen 443 ssl http2;
    server_name 2fa.example.com;

    ssl_certificate     /etc/letsencrypt/live/2fa.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/2fa.example.com/privkey.pem;

    # 同步接口
    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 2m;
    }

    # Web 端静态文件
    root /opt/twofa/apps/web/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Frame-Options "DENY" always;
}

server {
    listen 80;
    server_name 2fa.example.com;
    return 301 https://$host$request_uri;
}
```

**必须用 HTTPS**:访问令牌通过 `Authorization` 头传递,明文 HTTP 下
任何中间人都能截获令牌并越权拉取该用户的密文。

`try_files ... /index.html` 是为了让 Web 端在子路径部署时刷新不 404。

### 6. 微信小程序配置

同步服务地址是编译期常量,在 `apps/miniprogram/app.ts` 顶部:

```ts
const SYNC_BASE_URL = 'https://2fa.example.com';   // 改这里
```

改完重新构建小程序产物(`npm run build:miniprogram`),再用微信开发者工具
打开 `apps/miniprogram` 目录。

正式发布前还需要:

1. 微信公众平台 → 开发管理 → 服务器域名 → request 白名单,
   填入 `https://2fa.example.com`(必须是 https,不能带路径)
2. 开发阶段可在开发者工具里勾选「不校验合法域名」跳过限制

Web 端与扩展的同步地址则由用户在设置界面自己填,不需要改代码。

## 二、备份

无论用哪种数据库,**`credentials.json` 都必须备份**——
它存着同步账号的 scrypt 口令哈希,丢了会导致所有用户无法登录同步。

| 模式 | 备份对象 | 泄露后果 |
| --- | --- | --- |
| sqlite | `vaults.db` + `credentials.json` | 无法解读密文,但数据可被删除/覆盖 |
| postgres | `pg_dump` + `credentials.json` | 同上 |

### SQLite 模式

```bash
# 用 sqlite3 的在线备份,不会因正在写入而拿到损坏的副本
sqlite3 /var/lib/twofa/vaults.db ".backup '/var/backups/twofa-$(date +%F).db'"

# credentials.json 是普通文件,直接复制
cp /var/lib/twofa/credentials.json "/var/backups/twofa-credentials-$(date +%F).json"

# 保留 30 天
find /var/backups -name 'twofa-*' -mtime +30 -delete
```

不要直接 `cp` 数据库文件:服务正在写入时可能拷到半写状态。

### PostgreSQL 模式

```bash
# 自定义格式,支持并行恢复与选择性还原
pg_dump -Fc -U twofa -d twofa -f "/var/backups/twofa-$(date +%F).dump"

cp /var/lib/twofa/credentials.json "/var/backups/twofa-credentials-$(date +%F).json"

find /var/backups -name 'twofa-*' -mtime +30 -delete
```

用 `pg_dump` 而不是直接拷数据目录:数据目录拷出来**很可能无法直接恢复**,
必须配好版本与归档设置才能用,不如用逻辑备份可靠。

恢复演练(建议每季度做一次,不然后出事才发现备份是坏的):

```bash
createdb -U twofa twofa_restore_test
pg_restore -U twofa -d twofa_restore_test --no-owner "/var/backups/twofa-2026-10-03.dump"
psql -U twofa -d twofa_restore_test -c "SELECT count(*) FROM vaults;"
dropdb -U twofa twofa_restore_test
```

### 数据规模

每条记录是加密后的保险库全文,每次改动重写整份密文。
所以**密文体积不随用户数增长过快**,一万个账号的库也就几 MB(PG 模式)。

真正的规模瓶颈是**写并发**:SQLite 整库串行写,用户集中同步时
写锁会让请求排队。所以生产环境默认走 PostgreSQL。

如果预期用户量超过几千、且出现多设备同时同步的写高峰,
再考虑后续引入增量更新(目前每次同步传的是整份密文)。

## 三、浏览器扩展

扩展是纯客户端,不走服务器。加载方式:

1. `chrome://extensions` → 打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选 `apps/extension/dist`
3. 访问任意登录页,点扩展图标

上架 Chrome Web Store 时需要补:`icons/` 目录(48/128px)、
`homepage_url`、`详细描述`。当前 `manifest.json` 已满足最小要求。

Firefox 可直接加载同一份产物(MV3 已支持),但 `service_worker`
需改名为 `background.scripts` 或用 `background.scripts` 兼容写法。

## 四、运维要点

### 健康检查

```bash
curl -fsS http://127.0.0.1:8787/health   # 存活
curl -fsS http://127.0.0.1:8787/ready    # 依赖就绪
```

配进监控,这两条任一失败即告警。

### 日志

服务用 `console.log` 输出到 stdout,由 systemd 收集:

```bash
journalctl -u twofa -f
```

`sync_log` 表只记元数据(设备名、版本、字节数、时间),
**不记录任何密文内容**,排查同步问题时可直接查。

### 密钥轮换

轮换 `TWOFA_TOKEN_SECRET` 会让所有已签发的访问令牌立即失效,
客户端会在下次同步时自动重新登录(要求用户重新输入主密码,保险库才能解密)。
选低峰期操作即可。**轮换不会影响数据**,密文不依赖它。

## 五、常见问题

**同步返回 409**
正常的并发冲突,客户端会拉取合并后重试。持续 409 说明多个客户端
在同一时间改同一个库——让用户确认是否多设备同时在编辑。

**启动报 "PostgreSQL 不可用"**
按可能性排序排查:

1. `TWOFA_DATABASE_URL` 的 host/port 与实际实例是否一致
2. `sslmode` 是否与实例配置匹配(自建实例通常用 `require`,不是 `verify-full`)
3. 账号密码是否正确,以及该账号是否有 `CONNECT` 权限
4. 实例的 `pg_hba.conf` 是否放行了应用服务器的 IP
5. 实例的 `max_connections` 是否已被打满

服务启动时就会 `Ping` 一次,连不上直接退出,**不会**静默改用本地文件。
用 `psql "postgres://twofa:密码@127.0.0.1:5432/twofa?sslmode=require" -c "SELECT 1"`
先确认连接串本身通不通,再回来看服务日志。

**想把生产库换成 PostgreSQL**
密文信封是自描述的,与存储层无关,直接搬两张表的数据即可,无需解密。
先在 sqlite 模式下 `sqlite3 vaults.db .dump` 看一眼表结构,
再到 PG 里建同样的表(`BIGSERIAL` 替 `AUTOINCREMENT`),
然后导数据。迁移期间 `TWOFA_TOKEN_SECRET` 必须保持一致。

**提示"云端数据无法用当前主密码解密"**
两端主密码不同。端到端加密的必然结果——服务端没有能力帮你解决,
因为它没有密钥。重新用正确主密码的设备解锁并同步即可。

**小程序提示"不在合法域名列表"**
公众平台的 request 白名单没配,或用了 http 而非 https。

**验证码在手机上对、在扩展里不对**
两端时钟偏差超过 30 秒。Web 端和扩展会尝试用服务器 `Date` 头校准;
小程序需在设置里手动触发校准。设备系统时间不准是常见根因。
