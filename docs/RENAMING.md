# 改名影响面清单

主名尚未定稿。本文档列出代码里所有涉及品牌名的位置,
按**改名成本**分三级,供定名后一次性收敛。

统计时间:2026-10-03,基于 `ca73ee3`。命中文件 37 个(已排除
`node_modules` 与 `dist/` 构建产物)。

> **2026-10-04 更新:A、B 两级均已执行完毕,统一为 `twofa`。**
> 用户拍板"A 级可以改掉,目前还没有发布上线" —— 这是唯一的安全窗口,
> 已用掉。**从此刻起 A 级永久冻结。**
> **C 级也已执行完毕(同日,主名定稿 `secondtally` 之后),见文末《执行记录》。**
> **三级全部收敛完成,改名工作结束。**

## 分级标准

判断依据只有一条:**改了会不会丢用户数据、会不会静默失效。**

| 级别 | 判据 | 改的代价 |
| --- | --- | --- |
| **A 数据契约** | 改了已落盘的数据读不出来 | **发布后不可改**;发布前的窗口已用掉 |
| **B 工程标识** | 编译期能发现,或纯内部约定 | 可改,机械替换 |
| **C 展示层** | 只影响用户看到的字面 | 最便宜,改文案即可 |

---

## A 级:数据契约(7 处,**已于 2026-10-04 剥离品牌名**)

这些是**已落盘数据的读取钥匙**。E2E 模型下没有找回通道 ——
改错等于让用户永久丢失保险库。

| 位置 | 旧键 | 新键 |
| --- | --- | --- |
| `packages/core/src/vault/service.ts:51` | `aegis.vault.v1` | `twofa.vault.v1` |
| `packages/core/src/vault/service.ts:52` | `aegis.lock.v1` | `twofa.lock.v1` |
| `apps/web/src/platform.ts:25` | `aegis.web.v1.` | `twofa.web.v1.` |
| `apps/extension/src/platform.ts:26` | `aegis.ext.v1.` | `twofa.ext.v1.` |
| `apps/extension/src/background.ts:24` | `aegis.ext.v1.` | `twofa.ext.v1.` |
| `apps/miniprogram/platform.ts:108` | `aegis.` | `twofa.` |
| `apps/web/src/main.ts:678` | `aegis.web.v1.` | `twofa.web.v1.` |

**为什么现在可以做**:产品未发布,无外部用户数据。
开发机上若建过测试保险库,旧键会读不到(数据本身没被删,
只是没人去读),重新创建即可 —— 这是此刻唯一的代价。

### 为什么保留前缀,只换掉其中的品牌部分

早先建议过干脆去掉前缀(`vault.v1`、`session.<account>`),
**那个建议漏了一个约束:Web 端的 `localStorage` 按来源共享。**
同一域名下的任何页面都能读写它。裸键名有两个后果:

- 可能与其他页面撞车;
- "清空本机数据"按前缀匹配时,会把不属于本应用的键一起删掉。

小程序与扩展的存储是隔离的,但 Web 不是。**所以前缀必须留着,
只是把 `aegis` 换成与品牌无关的品类词 `twofa`。**

### 从此刻起永久冻结

`twofa.` 描述的是应用品类,不是品牌 —— 这正是剥离的目的:
**主名将来换成什么都不必再碰这一层。**

反过来说,再改一次就不是"改名"而是"数据迁移"了。发布后若确有
必要改,唯一安全的做法是新版本同时读旧键并迁移,旧键保留至少两个
大版本,且迁移逻辑本身要有测试。**那已经不是本次改名的范畴。**

### 新增的护栏

三端各自硬编码一份前缀,既没有共享常量也没有类型约束。
**某一端漏改不会编译报错,也不会让任何既有测试失败** ——
它只在用户换设备同步时表现为"数据在另一台机器上读不出来"。

故新增 `packages/core/test/storage-keys.test.mjs`,把 7 处钉死:
断言各端前缀都等于同一个命名空间、core 的 vault/lock 键落在该命名空间下、
Web 端清空用的前缀与存储前缀一致。
已用变异验证过(故意把 Web 端前缀改成 `twofaX.web.v1.`,测试确实失败)。

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

## C 级:展示层(14 处 + 1 处补漏,**已于 2026-10-04 执行完毕**)

用户能看到的字面,改起来零风险。清单已按 2026-10-04 全量扫描更新,
比初版多出 3 处。

| # | 位置 | 改名前的值 | **改为** |
| --- | --- | --- | --- |
| 1 | `apps/miniprogram/pages/gate/index.wxml:3` | `<view class="title">Aegis</view>` | `<view class="title">SecondTally</view>` |
| 2 | `apps/miniprogram/app.json:15` | `navigationBarTitleText: "Aegis 2FA"` | `"SecondTally"` |
| 3 | `apps/miniprogram/package.json:5` | `description: "Aegis 2FA 微信小程序端"` | `"SecondTally 微信小程序端"` |
| 4 | `apps/miniprogram/project.config.json:2` | `description: "Aegis 2FA 双重认证器"` | `"SecondTally 双重认证器"` |
| 5 | `apps/extension/src/manifest.json:3` | `name: "Aegis 2FA"` | `"SecondTally"` |
| 6 | `apps/extension/src/manifest.json:15` | `default_title: "Aegis 2FA"` | `"SecondTally"` |
| 7 | `apps/extension/src/popup.html:5` | `<title>Aegis 2FA</title>` | `<title>SecondTally</title>` |
| 8 | `apps/extension/src/popup.ts:159` | `` `Aegis · ${n} 个账号` `` | `` `SecondTally · ${n} 个账号` `` |
| 9 | `apps/web/index.html:7` | `<title>Aegis 2FA</title>` | `<title>SecondTally — OTP 验证器 · 双因子动态口令</title>` |
| 10 | `apps/web/src/main.ts:68` | `el('h1', { text: 'Aegis 2FA' })` | `el('h1', { text: 'SecondTally' })` |
| 11 | `apps/web/src/main.ts:222` | 同上 | 同上 |
| 12 | `README.md:1` | `# Aegis 2FA` | `# SecondTally` |
| 13 | `docs/DEPLOY.md:191` | `Description=Aegis 2FA Sync Server` | `Description=SecondTally Sync Server` |
| 14 | `server-go/go.mod:1` 与 `cmd/twofa-server/main.go:1` | 文件头注释 | 改为 `SecondTally` |
| **15** | **`.env.example:2`** | `# Aegis 2FA 同步服务配置` | `# SecondTally 同步服务配置` |

**第 15 处是执行时新发现的** —— 前一轮全量扫描漏掉了点文件里的**注释头**
(此前只修了该文件里的 `AEGIS_*` 变量名,没注意第 2 行的品牌名注释)。
再次印证 §B 级那节的教训:**点文件必须单独扫。**

**各位置用词不统一的说明(刻意的)**:

- 小程序导航栏标题、扩展名、h1 用**纯品牌名** `SecondTally` —— 这些是品牌位
- Web `<title>` 用**品牌名 + 品类词** —— title 同时是搜索引擎摘要位
- 微信**注册**名称另定(品牌词 + 品类词,见 `docs/NAMING.md` §1.4),
  与 `app.json` 的 `navigationBarTitleText` 是两件事

**为什么不抽成常量**:C 级就是要分散在各处,集中反而增加改动量。
保持字面量,`grep -i <新名>` 一次就能全部找到。

---

## 当前代码的实际问题

不是"有 37 个文件含品牌名",而是:

1. ~~**A 级与 B/C 级混在同一批字面量里。**~~
   **已解除(2026-10-04)。** 存储键前缀剥离后,
   `grep -rni aegis` 的结果里不再有数据契约键 ——
   "绝不能改"与"随便改"的两类字符串在字面上已经分开了。

2. **没有单一来源。** 每个平台的存储键前缀各写一份
   (`platform.ts` / `background.ts` / `main.ts` 三处都有 `twofa.web.v1.` 或 `twofa.ext.v1.`),
   靠约定维持同步。**这是没有解决的** —— 抽成共享常量要动 core 的公共导出面,
   收益不足以抵消改动量。已改用测试兜底(见 A 级《新增的护栏》),
   代价从"静默丢数据"降为"跑 `npm test` 就红"。

3. ~~**B3 的 16 处引用本可以更集中**~~ —— 已随 B 级一起改完,
   仍是散在 `main.ts`,但已是纯内部命名,改错代价低。

## 收敛动作(三级全部完成)

| 步骤 | 动作 | 状态 |
| --- | --- | --- |
| 1 | A 级 7 处存储键 → `twofa.*` + 护栏测试 | ✅ 2026-10-04(`4179a90`) |
| 2 | B 级 38 文件代码标识符 → `twofa` | ✅ 2026-10-04(`cb1af41`) |
| 3 | C 级 14+1 处展示文案 → `SecondTally` | ✅ 2026-10-04 |
| 4 | 四端重新构建 + `npm test` + `go test` | ✅ 全通过 |

**A 级从此刻起冻结,不再参与任何改名。改名工作到此结束。**

改完后 `grep -rni aegis` 只剩三处,且都不该改:

1. `docs/NAMING.md` 与 `docs/RENAMING.md` / `docs/STATUS.md` 里
   对"Aegis 竞品"的**历史论述** —— 那是改名的**理由记录**,删了就没人知道当初为什么改
2. `.gitignore` 里的 `*.aegisvault` —— 那是**竞品 Aegis 的导出文件格式**,与本项目品牌名无关
3. 本文件 C 级表里的"改名前的值"列 —— 那是**改动记录**

**源码与构建产物中的 `Aegis` 已归零**(实测 `apps/*/dist` 与 `apps/miniprogram/utils` 零残留)。

## 关于"要不要趁现在剥离存储键前缀"

**结论已翻转:剥离了。** 2026-10-04 用户拍板"A 级可以改掉,
目前还没有发布上线",窗口期成立,已执行。

下面保留当初**反对**剥离的三条理由,因为它们说明了这件事为什么
当时不该草率做、以及现在做需要额外补什么:

1. ~~**已经不需要了。**~~ 这条没错但不够 ——
   它只论证了"不改也能活",没论证"改了更好"。
   真正让天平倾斜的是:剥离后**存储键与品牌名彻底解耦**,
   将来主名再换(而主名一定会换)就永远不必再评估这一层。
2. **剥离本身有风险** —— **这条成立,且已针对性消解。**
   改 7 处要同时改小程序按前缀全清的逻辑,漏改的后果是
   老数据清不掉或新数据被误清;而且当时**没有任何测试能证明改对了**。
   所以这次补了 `storage-keys.test.mjs` 把 7 处钉死并做了变异验证,
   风险从"只能靠端到端手工验证"降为"`npm test` 直接兜住"。
3. ~~**成本不对称。**~~ 前提是"未来 0 次改名"。
   但主名尚未定稿、候选还在变,未来改名次数是 ≥1 而非 0,前提不成立。

> 存储键泄漏的是数据,包名泄漏的是代码 —— 二者不该绑定。
> 这条仍然成立:`twofa.` 是品类词不是品牌名,现在二者已经解耦。

---

## 执行记录(A + B 级,2026-10-04)

### 改了什么

**B 级(工程标识)**:

| 原值 | 新值 | 处数 |
| --- | --- | --- |
| `aegis-2fa` | `twofa` | 根包名 |
| `@aegis/core` | `@twofa/core` | scope + `tsconfig.base.json` paths + 各端 import |
| `module aegis/server` | `module twofa/server` | `go.mod` + 全部 import |
| `cmd/aegis-server/` | `cmd/twofa-server/` | 目录 + 二进制名 |
| `AEGIS_*` | `TWOFA_*` | `config.go` / 测试 / `.env.example` / `DEPLOY.md` |
| `window.aegis` | `window.twofa` | Web 端声明与 14 处调用 |

**A 级(数据契约,7 处)** —— 用户拍板后追加执行:

| 原值 | 新值 |
| --- | --- |
| `aegis.vault.v1` | `twofa.vault.v1` |
| `aegis.lock.v1` | `twofa.lock.v1` |
| `aegis.web.v1.*` | `twofa.web.v1.*` |
| `aegis.ext.v1.*` | `twofa.ext.v1.*` |
| `aegis.device.id.v1` | `twofa.device.id.v1` |
| `aegis.device.name.v1` | `twofa.device.name.v1` |
| `aegis.session.<account>` | `twofa.session.<account>` |

后三族不是字面量,由 `apps/miniprogram/platform.ts` 的
`STORAGE_NAMESPACE` 拼接而来 —— 该常量从 `'aegis.'` 改成 `'twofa.'`
即一并覆盖。这也是当初把键收敛到单一命名空间常量换来的好处:
剥离前缀实质只改了一处常量 + 三份平台前缀。

**未做旧键迁移。** 产品未发布、无外部用户数据;开发机上的测试
保险库会读不到(旧键还在,只是没人读),重新创建即可。

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
| A 级(B 级执行时) | 脚本断言 + 全量扫描 + 产物抽查,三重确认未变 |

产物抽查:`apps/extension/dist/background.js` 含 `twofa` 命名空间。

### A 级执行后的复验

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 78 项全通过(74 原有 + 4 新增存储键) |
| 新增测试变异验证 | 故意把 Web 前缀改成 `twofaX.web.v1.` → 测试确实失败 |
| 代码层残留旧键 | `grep -rn "aegis\."` 为空 |
| 四端重新构建 | 成功,产物内键名为 `twofa.*` |

**注意:74 项原有测试里没有一条会撞上存储键改动。** 它们测的是密码学、
合并逻辑与跨端取码一致性,存储键从不参与断言。也就是说这次改动
**在补测试之前是完全没有安全网的** —— 这正是必须补
`storage-keys.test.mjs` 的理由,而不是可选项。

### 顺带修掉的既有缺陷

**`server-go/cmd/` 从未进过版本库。** `.gitignore` 里的裸 `aegis-server`
匹配了同名的源码目录,`git ls-files server-go/` 里没有任何 `cmd/` 文件 ——
也就是说服务端的**入口源码在前面三个提交中一直缺席**,clone 下来无法构建。
已改为锚定写法,现在 `git status` 能看到
`?? server-go/cmd/twofa-server/main.go`。

---

## C 级执行记录(2026-10-04,主名定稿 `secondtally` 之后)

### 用词规则(刻意不统一)

| 位置                        | 用什么                     | 理由                        |
| ------------------------- | ----------------------- | ------------------------- |
| 小程序导航栏 / 扩展名 / Web h1     | 纯品牌名 `SecondTally`       | 品牌位                       |
| Web `<title>`             | 品牌名 + 品类词               | title 同时是搜索引擎摘要位          |
| 微信**注册**名称                | 品牌词 + 品类词(另定)           | 见 `docs/NAMING.md` §1.4    |

**注意**:`app.json` 的 `navigationBarTitleText` 是页面标题栏文字,
与**微信后台注册的小程序名称是两件事**,不要混。

### 执行时新发现的一处漏网

`.env.example:2` 的注释头 `# Aegis 2FA 同步服务配置` —— 前一轮只修了该文件里的
`AEGIS_*` 变量名,没注意第 2 行的品牌名注释。
**再次印证 B 级那节的教训:点文件必须单独扫。**

### 验证结果

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | **78 项**全通过 |
| `gofmt -l .` | 空 |
| `go build ./...` / `go vet ./...` | 干净 |
| `go test ./...` | auth / config / httpapi / store 全 ok(**顶层 68 项**,含子测试 92) |
| 四端构建 | 全部成功,扩展清单校验输出 `SecondTally v0.1.0 (manifest v3)` |
| 产物残留 | `apps/extension/dist` · `apps/web/dist` · `apps/miniprogram/utils` **零 `Aegis`** |
| 源码残留 | 仅剩 `docs/` 里的历史论述与本文的改动记录(见上文,不该改) |

**顺带修正文档里的过期数字**:`README.md` 原写"74 项测试(三端)/ 52 项服务端测试"
→ 已更正为 **78 项前端 / 68 项 Go**;`docs/STATUS.md` 的"52 项"同为过期值。

### 遗留(未在本轮处理)

`LICENSE` 文件缺失。**没有许可证 = 默认"保留所有权利",严格说不构成开源发布。**
客户端与服务端的授权需求不同(服务端若要用 AGPL-3.0 阻止闭源商用,
客户端通常用 MIT / Apache-2.0),需项目所有者拍板后添加。
