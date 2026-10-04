# 改名影响面清单

主名尚未定稿。本文档列出代码里所有涉及品牌名的位置,
按**改名成本**分三级,供定名后一次性收敛。

统计时间:2026-10-03,基于 `ca73ee3`。命中文件 37 个(已排除
`node_modules` 与 `dist/` 构建产物)。

> **2026-10-04 更新:B 级已执行完毕,品牌前缀统一为 `twofa`。**
> 见文末《执行记录》。A 级 7 处**刻意未动**,C 级 14 处**刻意保留
> `Aegis` 字面**等主名定稿 —— 这两条都是决定不是遗漏。

## 分级标准

判断依据只有一条:**改了会不会丢用户数据、会不会静默失效。**

| 级别 | 判据 | 改的代价 |
| --- | --- | --- |
| **A 数据契约** | 改了已落盘的数据读不出来 | 不可改,只能新版本迁移 |
| **B 工程标识** | 编译期能发现,或纯内部约定 | 可改,机械替换 |
| **C 展示层** | 只影响用户看到的字面 | 最便宜,改文案即可 |

---

## A 级:数据契约(7 处,永不改动)

这些是**已落盘数据的读取钥匙**。E2E 模型下没有找回通道 ——
改错等于让用户永久丢失保险库。

| 位置 | 键 |
| --- | --- |
| `packages/core/src/vault/service.ts:51` | `aegis.vault.v1` |
| `packages/core/src/vault/service.ts:52` | `aegis.lock.v1` |
| `apps/web/src/platform.ts:25` | `aegis.web.v1.` (前缀) |
| `apps/extension/src/platform.ts:26` | `aegis.ext.v1.` (前缀) |
| `apps/extension/src/background.ts:24` | `aegis.ext.v1.` (前缀) |
| `apps/miniprogram/platform.ts:108` | `aegis.` (`STORAGE_NAMESPACE`) |
| `apps/web/src/main.ts:678` | `aegis.web.v1.` (清空时按前缀匹配) |

**结论:A 级不动。** 品牌名换成什么,存储键都保持 `aegis.`。

这带来一个现实约束:**老用户升级到改名后的版本时,
存储键仍是 `aegis.`,新旧版本可以共存。**
所以主名可以事后改,不必在发布前定死。

但窗口期仍值得利用:若现在把 `aegis.` 换成中性前缀(如 `otp2fa.`),
将来就不必再动。代价是要同时改 7 处 + 小程序清空逻辑的风险。
**建议:保持现状不动**,理由见文末。

---

## B 级:工程标识(已执行,2026-10-04)

编译期能发现全部遗漏,或纯属内部约定。**全部已改成 `twofa`。**

### B1. npm 包 scope(12 处)—— 已改为 `@twofa/*`

`@aegis/core` / `@aegis/extension` / `@aegis/miniprogram`

| 位置 | 说明 |
| --- | --- |
| `package.json` | 根包名 `aegis-2fa` |
| `packages/core/package.json` | `@aegis/core` |
| `apps/*/package.json` | 三端各自的 name |
| `tsconfig.base.json:18` | `paths` 映射 |
| 各端 `import ... from '@aegis/core'` | 源码导入 |

**注意**:改 scope 名要同步改 `tsconfig.base.json` 的 `paths`。
漏改的症状是"TS 找不到模块",编译期报错,安全。

### B2. Go module 路径(10 处)—— 已改为 `twofa/server`

`go.mod` 的 `module aegis/server` + 所有 import。

```go
import "aegis/server/internal/auth"
```

`server-go/cmd/aegis-server/` 目录名也含品牌名。

**注意**:改 module 名后 `go build` 会立刻失败并列出所有断掉的 import,
改法是 `sed` 批量替换后 `go mod tidy`。风险低。

### B3. `window.aegis` 全局命名空间(16 处)—— 已改为 `window.twofa`

`apps/web/src/platform.ts:138-142` 声明,`:243` 赋值,
`main.ts` 里 14 处调用。

这是**纯内部约定**,不存在数据契约问题。

**注意**:不能写成 `window.2fa`。JS 标识符不能以数字开头,
`window.2fa = 1` 是语法错误(`Invalid or unexpected token`,已实测)。
所以代码层用 `twofa`,而展示层文案想写 `2FA` 不受此限。

### B4. `AEGIS_` 环境变量(22 处,Go 侧)—— 已改为 `TWOFA_`

`AEGIS_ENV` / `AEGIS_TOKEN_SECRET` / `AEGIS_ALLOWED_ORIGINS` /
`AEGIS_DATA_DIR` / `AEGIS_DB_DRIVER` / `AEGIS_DATABASE_URL` /
`AEGIS_TOKEN_TTL` / `AEGIS_LOG_LEVEL`

集中在 `internal/config/config.go` 与错误消息里,另加 `.env.example` 与
`docs/DEPLOY.md`。

**注意**:同样不能写成 `2FA_`。`export 2FA_ENV=test` 在 shell 里报
`not a valid identifier`(已实测),所以是 `TWOFA_` 不是 `2FA_`。

**⚠ 唯一的真风险点**:改环境变量名会让**已部署的 systemd 单元失效**。
`EnvironmentFile` 里的旧变量名不被识别 → 服务用开发默认值启动 →
生产环境密钥校验会拒绝(反而安全,但用户会看到服务起不来)。

改法:新旧变量名都读,过渡期再删旧的。`config.go` 已有
`getenvDefault` 辅助函数,加一层别名成本很低。

### B5. 构建产物名(2 处)—— 已改为 `twofa-server`

- `server-go/cmd/twofa-server/`(目录名,含二进制名)
- `docs/DEPLOY.md` 里的 `dist/twofa-server`

**踩到的坑**:`.gitignore` 原本写的是裸的 `aegis-server`(不带前导 `/`),
而二进制名与源码目录名**同名** —— 结果 `server-go/cmd/aegis-server/`
整个源码目录被一起忽略。`git ls-files server-go/` 证实:**入口
`main.go` 从未进过版本库**,改名前的三个提交里都没有它。

已修成锚定写法 `/twofa-server` + `/server-go/twofa-server`。
**换二进制名时必须检查这一条**,否则会静默丢掉整个入口目录。

---

## C 级:展示层(14 处,最便宜,**刻意未改**)

用户能看到的字面,改起来零风险。清单已按 2026-10-04 全量扫描更新,
比初版多出 3 处。

| # | 位置 | 当前值 |
| --- | --- | --- |
| 1 | `apps/miniprogram/pages/gate/index.wxml:3` | `<view class="title">Aegis</view>` |
| 2 | `apps/miniprogram/app.json:15` | `navigationBarTitleText: "Aegis 2FA"` |
| 3 | `apps/miniprogram/package.json:5` | `description: "Aegis 2FA 微信小程序端"` |
| 4 | `apps/miniprogram/project.config.json:2` | `description: "Aegis 2FA 双重认证器"` |
| 5 | `apps/extension/src/manifest.json:3` | `name: "Aegis 2FA"` |
| 6 | `apps/extension/src/manifest.json:15` | `default_title: "Aegis 2FA"` |
| 7 | `apps/extension/src/popup.html:5` | `<title>Aegis 2FA</title>` |
| 8 | `apps/extension/src/popup.ts:159` | `Aegis · N 个账号` |
| 9 | `apps/web/index.html:7` | `<title>Aegis 2FA</title>` |
| 10 | `apps/web/src/main.ts:68` | `<h1>Aegis 2FA</h1>` |
| 11 | `apps/web/src/main.ts:222` | `<h1>Aegis 2FA</h1>` |
| 12 | `README.md:1` | `# Aegis 2FA` |
| 13 | `docs/DEPLOY.md:191` | `Description=Aegis 2FA Sync Server` |
| 14 | `server-go/go.mod:1` 与 `cmd/twofa-server/main.go:1` | 文件头注释 |

**这些恰恰是主名定稿后必须改的**,也是唯一"改完立刻见效"的部分。

**为什么不现在随手改掉**:微信小程序**年度改名上限 2 次**(见
`docs/NAMING.md`)。现在填一个占位名,等主名定稿再改,会白白消耗
一次名额 —— 而小程序名称正是最需要留给主名的位置。其余各端同理:
改两次不如一次到位。

**建议**:这里**不要**抽成常量。C 级就是要分散在各处,
集中反而增加改动量 —— 集中了就得改一个文件而非只改文案。
让它们保持字面量,`grep -i <新名>` 一次就能全部找到。

---

## 当前代码的实际问题

不是"有 37 个文件含品牌名",而是:

1. **A 级与 B/C 级混在同一批字面量里。**
   `aegis.vault.v1`(绝不能改)与 `window.aegis`(随便改)长得几乎一样。
   `grep -i aegis` 出来的结果里,改错的代价差了几个数量级。
   —— 这才是"改动多一些"的根源,不是数量问题。

2. **没有单一来源。** 每个平台的存储键前缀各写一份
   (`platform.ts` / `background.ts` / `main.ts` 三处都有 `aegis.web.v1.` 或 `aegis.ext.v1.`),
   靠约定维持同步。

3. **B3 的 16 处引用本可以更集中**,却散在 `main.ts` 里。

## 定名后的收敛动作(只剩 C 级)

B 级已于 2026-10-04 全部完成,定名后**只需改 C 级 14 处文案**:

| 步骤 | 动作 | 风险 |
| --- | --- | --- |
| 1 | C 级 14 处改文案(上表) | 无 |
| 2 | 四端重新构建 + `npm test` | 无 |

**A 级 7 处全程不动。**

改完后 `grep -rni aegis` 应当只剩:
A 级 7 处存储键、`docs/NAMING.md` 与 `docs/RENAMING.md` 里对"Aegis
竞品"的历史论述、以及 `.gitignore` 里的 `*.aegisvault`
(那是**竞品 Aegis 的导出文件格式**,与本项目品牌名无关,不该改)。

## 关于"要不要趁现在剥离存储键前缀"

**建议:不剥离。** 三个理由:

1. **已经不需要了。** A 级保持 `aegis.` 时,新旧版本可共存,
   改名不影响数据读取。主名从 Aegis 换到任何新名字都不必碰存储键。
2. **剥离本身有风险。** 改 7 处存储键要同时改小程序按前缀全清的逻辑
   (`wipeAllStorage`),漏改的后果是老数据清不掉或新数据被误清。
   而且 7 处改完**没有任何测试能证明改对了** ——
   只能靠端到端手工验证。
3. **成本不对称。** 存储键剥离省下的是"未来 0 次改名",
   付出的是"现在 1 次高风险改动"。

> 唯一值得重新考虑的情况:如果主名会**同时**用作 npm scope 和 Go module 名,
> 且希望存储键与包名保持一致的直觉,那才值得统一。
> 但存储键泄漏的是数据,包名泄漏的是代码 —— 二者不该绑定。

---

## 执行记录(B 级,2026-10-04)

### 改了什么

| 原值 | 新值 | 处数 |
| --- | --- | --- |
| `aegis-2fa` | `twofa` | 根包名 |
| `@aegis/core` | `@twofa/core` | scope + `tsconfig.base.json` paths + 各端 import |
| `module aegis/server` | `module twofa/server` | `go.mod` + 全部 import |
| `cmd/aegis-server/` | `cmd/twofa-server/` | 目录 + 二进制名 |
| `AEGIS_*` | `TWOFA_*` | `config.go` / 测试 / `.env.example` / `DEPLOY.md` |
| `window.aegis` | `window.twofa` | Web 端声明与 14 处调用 |

### 为什么是 `twofa` 而不是 `2fa`

`2fa` 在**展示层**完全合法(副标题、标题、`manifest.json` 都能写),
但在**代码标识符层**有两处硬约束,均已实测:

| 写法 | 结果 |
| --- | --- |
| `window.2fa = 1` | `SyntaxError: Invalid or unexpected token` |
| `export 2FA_ENV=test` | `bash: not a valid identifier` |

JS 标识符与 shell 变量名都不能以数字开头。所以代码层统一 `twofa`,
Go 环境变量统一 `TWOFA_`。**这是语法限制不是偏好。**

### 保护式替换的做法

一次性脚本 `scripts/rename-to-twofa.mjs`(用完即删)分三段:

1. **保护**:把 7 个 A 级键替换成 `\u0000A{i}\u0000` 占位符;
2. **替换**:`AEGIS_` → `TWOFA_`、其余 `aegis` → `twofa`;
3. **还原**:占位符换回原键,并断言 A 级键逐条未变。

即便如此仍漏了 3 类不在保护列表里的形式,靠全量扫描补回:

- `docs/STATUS.md` 的 `getaegis.app`(**竞品真实官网**,不是品牌名)
- `docs/STATUS.md` 的 `aegis.device.v1`(出现在散文里的数据契约键)
- `.env.example`(**点文件**,脚本的 glob 没覆盖到)

### 验证结果

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 74 项全通过(含跨端一致性比对) |
| `gofmt -l .` | 空 |
| `go build ./...` / `go vet ./...` | 干净 |
| `go test ./...` | auth / config / httpapi / store 全 ok |
| 四端构建 | core / miniprogram / web / extension 成功 |
| Go 二进制 | `dist/twofa-server` 构建成功 |
| A 级 7 处存储键 | 脚本断言 + 全量扫描 + 产物抽查,三重确认未变 |

产物抽查:`apps/extension/dist/background.js` 含 `twofa` 命名空间、
`aegis.ext.v1` / `aegis.vault.v1` / `aegis.lock.v1` 三个键原样保留。

### 顺带修掉的既有缺陷

**`server-go/cmd/` 从未进过版本库。** `.gitignore` 里的裸 `aegis-server`
匹配了同名的源码目录,`git ls-files server-go/` 里没有任何 `cmd/` 文件 ——
也就是说服务端的**入口源码在前面三个提交中一直缺席**,clone 下来无法构建。
已改为锚定写法,现在 `git status` 能看到
`?? server-go/cmd/twofa-server/main.go`。
