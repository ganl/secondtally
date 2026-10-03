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

服务端的 `AEGIS_TOKEN_SECRET` 泄露后果:攻击者能伪造访问令牌、
拉取任意用户的密文离线研究、或越权写入。**无法解密**,但必须保密。

## 一、服务端部署

### 1. 构建

```bash
git clone <你的仓库> /opt/aegis
cd /opt/aegis
npm ci
npm run build          # 依次构建 core / web / ext / server
```

产物位置:

- `server/dist/index.js` — 服务端
- `apps/web/dist/` — Web 端静态文件
- `apps/extension/dist/` — 浏览器扩展(手动加载,不部署)
- `apps/miniprogram/` — 微信小程序(用开发者工具打开)

### 2. 配置

```bash
cp .env.example .env
openssl rand -hex 32      # 生成令牌密钥
```

编辑 `.env`,生产环境至少改这几项:

```ini
NODE_ENV=production
HOST=127.0.0.1              # 只监听回环,由反代对外
AEGIS_TOKEN_SECRET=<上面生成的值>
AEGIS_ALLOWED_ORIGINS=https://2fa.example.com
AEGIS_DATA_DIR=/var/lib/aegis
```

`AEGIS_ALLOWED_ORIGINS` 必须写你的真实站点来源,不能留 `*`。
生产环境若留通配,任何网站都能读取用户的同步接口。

完整配置项见 `.env.example` 内的注释。

### 3. systemd 服务

`/etc/systemd/system/aegis.service`:

```ini
[Unit]
Description=Aegis 2FA Sync Server
After=network.target

[Service]
Type=simple
User=aegis
Group=aegis
WorkingDirectory=/opt/aegis
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
RestartSec=3

# 安全加固:服务只需要读代码和写数据目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/aegis
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6

EnvironmentFile=/opt/aegis/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin aegis
sudo mkdir -p /var/lib/aegis && sudo chown aegis:aegis /var/lib/aegis
sudo systemctl daemon-reload
sudo systemctl enable --now aegis
sudo systemctl status aegis
```

### 4. Nginx 反代

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
    root /opt/aegis/apps/web/dist;
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

### 5. 微信小程序配置

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

服务端的数据目录里有两个文件,都要备份:

| 文件 | 内容 | 泄露后果 |
| --- | --- | --- |
| `vaults.db` | SQLite 库,存密文与同步日志 | 无法解读密文,但数据可被删除/覆盖 |
| `credentials.json` | 同步账号的 scrypt 口令哈希 + 刷新令牌哈希 | 可离线爆破同步账号口令 |

```bash
# 用 sqlite3 的在线备份,不会因正在写入而拿到损坏的副本
sqlite3 /var/lib/aegis/vaults.db ".backup '/var/backups/aegis-$(date +%F).db'"

# credentials.json 是普通文件,直接复制
cp /var/lib/aegis/credentials.json "/var/backups/aegis-credentials-$(date +%F).json"

# 保留 30 天
find /var/backups -name 'aegis-*' -mtime +30 -delete
```

不要直接 `cp` 数据库文件:服务正在写入时可能拷到半写状态。

数据规模参考:每条记录是加密后的保险库全文。一万个账号的库约几 MB ——
因为每次改动都重写整份密文。**这不适合万人规模**。
如果预期超过几千活跃用户,应该把存储层从 SQLite 换成支持增量更新的方案。

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
journalctl -u aegis -f
```

`sync_log` 表只记元数据(设备名、版本、字节数、时间),
**不记录任何密文内容**,排查同步问题时可直接查。

### 密钥轮换

轮换 `AEGIS_TOKEN_SECRET` 会让所有已签发的访问令牌立即失效,
客户端会在下次同步时自动重新登录(要求用户重新输入主密码,保险库才能解密)。
选低峰期操作即可。**轮换不会影响数据**,密文不依赖它。

## 五、常见问题

**同步返回 409**
正常的并发冲突,客户端会拉取合并后重试。持续 409 说明多个客户端
在同一时间改同一个库——让用户确认是否多设备同时在编辑。

**提示"云端数据无法用当前主密码解密"**
两端主密码不同。端到端加密的必然结果——服务端没有能力帮你解决,
因为它没有密钥。重新用正确主密码的设备解锁并同步即可。

**小程序提示"不在合法域名列表"**
公众平台的 request 白名单没配,或用了 http 而非 https。

**验证码在手机上对、在扩展里不对**
两端时钟偏差超过 30 秒。Web 端和扩展会尝试用服务器 `Date` 头校准;
小程序需在设置里手动触发校准。设备系统时间不准是常见根因。
