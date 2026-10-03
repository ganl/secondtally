# Aegis 2FA

端到端加密的 TOTP 双重认证器,支持微信小程序、Web 与浏览器扩展跨端使用。

同一条账号在三端算出的验证码完全一致——这不是巧合,而是由
`crossplatform.test.mjs` 对三份构建产物逐条比对验证的。

## 安全模型

一句话:**服务器只存密文,没有能力解密任何内容。**

| 内容 | 服务器可见? |
| --- | --- |
| TOTP 种子、账号、备注 | 否,仅 AES-256-GCM 密文 |
| 主密码 | 否,只存在于设备内存 |
| 恢复码 | 否,只存逐条加盐的哈希 |
| 同步账号口令 | 是,scrypt 哈希(仅用于 HTTP 层认证) |
| 访问令牌 | 是,短期有效 |

推论:数据库整体泄露也无法读取任何种子。代价是**主密码丢失 = 数据永久丢失**,
没有找回通道——这是端到端加密的必然结果,不是缺陷。

### 关键实现选择

- **纯 JS 密码学库**(`@noble/hashes`、`@noble/ciphers`)
  微信小程序不提供 `crypto.subtle`,这是唯一能同时跑通小程序与浏览器的方案。

- **PBKDF2 210,000 次迭代**
  OWASP 建议 600,000,但实测 600,000 在低端安卓机上需1.5–2 秒。
  210,000 是可用的折中。加载时会拒绝迭代数低于 100,000 的信封,防止降级攻击。

- **LWW-Element-Set + 墓碑**
  离线各自编辑后同步不会丢数据。删除用墓碑标记,否则另一端的旧版本会把它"复活"。
  冲突消解看 `updatedAt` 而非 `createdAt`——否则"删除后重新添加"无法胜出。

- **按`issuer|account` 去重**
  两台设备离线时各自添加同一账号会生成不同 id,LWW 集合会当成两个元素。
  合并时按服务名+账号去重,保留较新者。

- **审计日志不记验证码**
  验证码 30 秒即失效,留存没有审计价值,却会成为新的攻击面。

## 目录结构

```
packages/core/     密码学与 TOTP 引擎,零平台依赖,三端共用
server-go/         同步服务端(Go,编译为单个静态二进制)
apps/miniprogram/   微信小程序
apps/web/          Web 端
apps/extension/     MV3 浏览器扩展
docs/DEPLOY.md      自部署指南
```

## 快速开始

```bash
npm install
npm run build        # 构建 core / web / ext / server
npm test             # 74 项测试(三端)
npm run test:server  # 52 项服务端测试(Go)
npm run typecheck
```

服务端需要 [Go](https://go.dev/dl/) 1.22+;国内网络建议先配置代理
(`proxy.golang.org` 直连会返回 502):

```bash
go env -w GOPROXY=https://goproxy.cn,https://mirrors.aliyun.com/goproxy/,direct
```

### 本地跑服务端

```bash
cp .env.example .env
npm run build:server      # 产出 server-go/dist/aegis-server
npm run start:server
curl http://127.0.0.1:8787/health
```

服务端的运行期**不需要 Node** —— 目标机器上只要有那个二进制文件即可。
详见 [docs/DEPLOY.md](docs/DEPLOY.md)。

### 小程序

用微信开发者工具打开 `apps/miniprogram` 目录。
同步地址在 `apps/miniprogram/app.ts` 顶部的 `SYNC_BASE_URL`。

### Web

```bash
npx serve apps/web/dist
```

### 浏览器扩展

`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → `apps/extension/dist`。

扩展会在登录页自动识别验证码输入框并填入。识别依据是 `autocomplete="one-time-code"`
之类的结构属性,匹配不上时才退回提示文字猜测,以降低误填风险。

## 部署

见 [docs/DEPLOY.md](docs/DEPLOY.md),含 systemd 单元、Nginx 配置、
备份策略与常见问题。

数据目录有两个文件需要备份:`vaults.db`(密文)与 `credentials.json`(账号凭据)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [README.md](README.md) | 安全模型与关键实现选择(本文) |
| [docs/STATUS.md](docs/STATUS.md) | **决策记录、未决事项、必须守住的技术契约** |
| [docs/DESIGN.md](docs/DESIGN.md) | 界面设计系统与关键设计决策(待评审) |
| [docs/PORTING.md](docs/PORTING.md) | 移植到抖音等其他平台的评估 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 部署与运维 |

改动代码前建议先读 `docs/STATUS.md` 第四节 —— 那里记录了几处
**改动后会静默失效、且类型系统不会报错**的隐式契约。

## 已知限制

- **SQLite 存储每次改动重写整份密文**,不适合万人规模。几千活跃用户以内没问题。
- **扩展不提供同步**。跨端同步在 Web 与小程序之间进行,扩展是纯本地使用。
  MV3 的 service worker 生命周期不适合维持长连接。
- **扩展不支持扫码**。Chrome 扩展无法调起相机,强行用 `getUserMedia` 也不符合
  扩展商店隐私政策。只能手动输入种子。
- **恢复码不能单独解锁**。它不持有密钥,只用于重新同步保险库,仍需主密码解密。
- **时钟偏差会算错验证码**。Web 与扩展会用服务器 `Date` 头校准;设备系统时间不准是常见根因。
