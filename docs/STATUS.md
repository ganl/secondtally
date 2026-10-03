# 决策记录与当前状态

这份文档记录**讨论过程中定下的决策**和**尚未完成的事项**,供后续接手时快速对齐。
架构与实现原理见 `README.md`,部署见 `docs/DEPLOY.md` —— 本文不重复。

最后更新:2026-10-03(Go 服务端收尾完成后)

---

## 一、已完成

| 项 | 状态 | 备注 |
| --- | --- | --- |
| 三端构建打通 | 74/74 测试通过 | |
| 小程序 8 页面 | 编译 + typecheck 干净 | 设计待评审,见 `docs/DESIGN.md` |
| Web 端 | 产物 69 KB | |
| 浏览器扩展 MV3 | 9 项测试通过 | |
| 跨端一致性验证 | 5 条目逐条比对相同 | |
| **Go 服务端(已上线)** | **52 项测试 + 端到端实测全通过** | 替代原TypeScript 版 |
| TypeScript 服务端 | **已删除** | 见下方 2.1 |

### 2.1 服务端已切换为 Go

原 `server/`(TypeScript)已从版本控制删除,`server-go/` 为唯一实现。

**为什么删而不是并存**:两份实现意味着两份真相来源,
改了一处忘了另一处是必然的事。TS 版的行为已被Go 版完整覆盖并验证。

迁移要点:
- 数据目录从 `server/data/` 变为 `server-go/data/`,两个文件名相同
  (`vaults.db` / `credentials.json`),**可直接复制**
- 但 `AEGIS_TOKEN_SECRET` 必须一致,否则已签发令牌全部失效
- 环境变量 `AEGIS_ENV`(新)优先,`NODE_ENV`(旧)保留为兼容项

构建产物:`server-go/dist/aegis-server`,约 17 MB,纯 Go SQLite 驱动,
**无需 CGO**,可交叉编译。

---

## 二、已定下的决策

### 2.1 命名

**上一版记录为"`Aegis` 保留,暂不改"。此决策已被用户推翻,理由是品牌撞车。**
原方案源自希腊神话中雅典娜的神盾,取"守护凭证"之意。

#### 推翻理由(2026-10-03 查证,非凭印象)

**`Aegis` 已被同品类竞品完整占据,这不是"名字晦涩"而是"品牌撞车":**

- `github.com/beemdevelopment/Aegis` —— 9.2k stars,官网 getaegis.app,
  GPL-3.0,Google Play / F-Droid 上架,经过独立安全审计。
- 拿过 **PCMag 编辑之选**(2026),是各家"最佳 2FA 应用"榜单常客。
- **其核心卖点与本项目逐条重合**:AES-256-GCM 保险库、scrypt 主密码派生、
  导入其他验证器、加密导出、防止截屏。
- 推论:用户搜 "Aegis 2FA" 得到的全是它。任何 SEO / 应用商店 / 口头推荐
  都在为别人的产品导流。**撞车无解,晦涩可修,故必须改。**

#### 命名必须分三层,不能全局替换

用户已确认"代码名也可以调整",但代码名与产品名**不可混为一谈**:

| 层 | 内容 | 可否改名 |
| --- | --- | --- |
| 用户可见层 | 小程序标题栏、Web `<title>`/H1、扩展商店名、页面 H1、推广文案 | **必须改** |
| 代码标识符层 | `aegis-2fa`、`@aegis/core`、`aegis/server`、二进制名、`window.aegis` | 可改,约 50 处机械替换 |
| 数据契约层 | `aegis.vault.v1`、`aegis.lock.v1`、`aegis.device.v1` | **改名 = 用户丢数据** |

**第二层的连带风险(改前必须知道):**

- Go module 路径 `aegis/server/internal/*` 共 11 处 import,需同时改目录名与 `go.mod`。
- npm 包名 `@aegis/core` 等 3 处,改后必须重新`mklink /J` 重建 workspace 链接
  (Windows 下 `ln -s` 需管理员权限,此前已踩过)。
- 测试断言中 30 处 `window.aegis`,`grep -c` 逐文件确认。

**第三层为何不能动:**该键下存的是用户设备上唯一的加密保险库。
主密码不上传,云端无明文,**键名一改 = 读不出旧保险库 = 数据永久丢失**。
这不是"兼容性顾虑",是本项目 E2E 模型的必然结果。

**已确认的安全事实(改名的前提条件):**

- 存储键**仅在 `packages/core/src/vault/service.ts:45-47` 集中定义**三处常量,
  全部引用都走变量,无字面量散落。
- `packages/core/test/` 与 `apps/extension/test/` 中**无任何存储键字面量断言**
  (`grep -rn "aegis\."` 返回空)。
- 结论:因项目仅一个提交、未真实部署,现在改零代价;但必须**先改完再合入**,
  一旦有用户落盘就永久锁死。

### 2.2 平台范围

当前只做**微信小程序**。Web 与扩展已实现但属附带产出。

### 2.3 不采用跨端框架(Taro / uni-app)

已评估并否决。理由记录在 `docs/PORTING.md`,核心三条:

1. 跨端框架解决 80% 模板差异,但**剩余 20% 恰是本项目最依赖的部分**(加密随机数、扫码、身份体系),框架帮不上忙。
2. `CryptoRandom.bytes()` 是**同步**接口,而抖音侧 `tt.getRandomValues` 是异步。框架无法把异步变同步。
3. 本项目**已把最难跨端的部分隔离完毕** —— `packages/core` 1500 行零平台 API,天然 100% 跨端。框架能省的,恰是已经不需要省的。

若未来要上抖音:**新增 `apps/douyin/` 独立目录**,core 零改动。
不要为此改造整个工程为Taro —— 那是净损失。

### 2.4 界面设计现状

深色主题,已实现但**未经用户评审**。用户明确指出这是流程缺陷:
先写了代码才谈设计,导致返工成本升高。详见 `docs/DESIGN.md`。

### 2.5 服务端用 Go,不用 Node

需求是"有云服务器,实现独立后端后期自行部署"。
选Go 的原因是部署只需一个静态二进制,目标机器不需要装 Node 运行时。

**注意**:Go 1.22+ 的 `http.ServeMux` 支持方法级路由(`mux.HandleFunc("GET /x", ...)`),
且注册 `"/"` 兜底后会接管全部未匹配请求(实测确认,连方法不匹配的也是)。

---

## 三、未决事项(需用户拍板)

### 3.1 界面设计评审 ⏰ **当前进行中**

下列项由 AI 单方面决定,需确认:

| 项 | 当前值 | 可选 |
| --- | --- | --- |
| 主题 | 深色 `#0f172a` | 浅色(需重做整套色板) |
| 强调色 | 靛蓝 `#6366f1` | 其他 |
| 预警色 | 琥珀 `#f59e0b` | 其他 |
| 列表布局 | 左信息/ 右验证码 | 上下排列(列表更矮) |
| 添加入口 | 右下角 FAB | 顶部按钮 |
| 搜索 | 常驻搜索框 | 收进设置 |

### 3.2 计划发布 App ⏳

用户提到"最终可能要发布 App"。这会显著改变技术选型,需专门讨论:

- **安全存储必须换**:iOS 用 Keychain、Android 用 Keystore,
  不能沿用小程序的 `wx.setStorageSync` 或浏览器的 `localStorage`
- **跨端方案**:Flutter / React Native,与小程序框架(Taro/uni-app)是两套东西
- **可复用部分**:`packages/core` 是纯 TypeScript,
  React Native 可直接复用;原生端需重写平台适配层
- **待明确**:小程序与 App 是同一产品两个端,还是 App 为主?

这一项尚未展开,等界面设计定稿后单独讨论。

### 3.3 抖音端(未启动)

仅在用户确认要上抖音时才动手。预估:适配器 1 天 + 模板 1.5 天。

---

## 四、必须守住的技术契约

改动这些地方会**静默**破坏功能,没有任何类型系统会报错。

### 4.1 冲突必须返回 409

```typescript
// packages/core/src/sync/httpTransport.ts
if (error instanceof Error && /服务端返回 409/.test(error.message)) {
```

客户端靠**正则匹配错误消息里的 `409`** 判断冲突。Go 版必须真的返回 409 状态码,
改成 400/428 会让同步"看起来正常但悄悄失效"。

### 4.2 禁止 `Math.random()` 作为随机源

`packages/core/src/**` 中`Math.random` 会让 AES-GCM nonce 可预测,直接摧毁加密强度。
测试里有源码遍历断言,防止回归。

新增平台适配器时**绝不能**用 `Math.random` 兜底 —— 缺随机源就应报错。

### 4.3 绝对不能用 `Math.random()` 生成条目 id

已修复过一次。两台设备同毫秒生成相同 id,合并时会互相覆盖,静默丢数据。
现用注入的加密随机源。

### 4.4 scrypt 与 base64url 参数

Go 与 Node 间迁移数据时必须逐字节一致,否则用户突然登不上:

| 项 | 值 | 备注 |
| --- | --- | --- |
| scrypt | `N=16384, r=8, p=1, keyLen=64` | 参数不同则 `credentials.json` 互不认 |
| base64 | `base64.RawURLEncoding` ↔ Node `toString('base64url')` | 必须无填充、URL 安全字符集 |
| 令牌结构 | `base64url(payload).hex(hmac-sha256)` |非 JWT,为了支持即时吊销 |

### 4.5 账户枚举防护

用户不存在时**也执行一次 scrypt**,让响应时间接近。上重构极易丢掉这一步。

### 4.6 凭据文件损坏须拒绝启动

不能重置为空 —— 会让所有用户突然"不存在",表现为无法登录且无从排查。

### 4.7 未知端点必须返回 JSON,不能是纯文本

Go 的 `ServeMux` 在没有匹配路由时默认返回纯文本 `404 page not found`,
客户端 JSON 解析会直接失败。必须在 mux 上注册 `"/"` 兜底handler。

实测确认(Go 1.26):注册 `"/"` 后,**连"路径存在但方法不匹配"的请求也会落到兜底**,
拿不到 405。所以兜底 handler 只需统一返回 JSON 404,不必区分 404/405。

### 4.8 口令强度校验必须用归一化后的长度

`Register` 的 8 位门槛要用 NFKC 归一化**之后**的长度,不能用原始输入的字节数。
否则全角输入的用户会被误判为"密码太短"——因为 `ａｂｃ１２３` 归一化后只有 6 字符。
这个 bug 在测试里先表现为"NFKC 失效",其实是测试用例本身用了 6 位密码。

---

## 五、环境注意事项

### Go

```bash
export PATH="$PATH:/c/Program Files/Go/bin"   # 不在默认 PATH 里
```

`proxy.golang.org` 直连返回 **502**,已持久化国内镜像:

```bash
go env -w GOPROXY=https://goproxy.cn,https://mirrors.aliyun.com/goproxy/,direct
```

### 小程序 typecheck 的三个坑

顺序不能颠倒,详见 `apps/miniprogram/tsconfig.json` 内注释:

1. `utils/index.d.ts` 里的 `declare module` 转发声明**必须删掉**(会遮蔽真实解析)
2. `allowJs: false`(开了会优先用 `core.mjs` 而忽略生成的 `core.d.ts`)
3. `core.d.ts` 必须是 `.d.ts` 而非 `.d.mts`

各页面顶层必须用 `var appInstance = getApp()`,**不能用 `const`**(TS 判定小程序页面共享全局作用域)。

### 扩展测试

必须用 `exclusive()` 串行(`globalThis.chrome` 进程唯一);
用 `buildSync` 而非 `build`(后者留常驻句柄导致文件级超时);
临时目录带 `process.pid` + 序号。
