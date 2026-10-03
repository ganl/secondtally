# 移植到其他平台的评估

结论先行:**当前架构下,新增平台应新增独立目录,不应改造为跨端框架工程。**
理由见文末「为什么不用 Taro / uni-app」。

评估时间:2026-10-03,依据抖音开放平台官方文档实测查证,非凭印象。

---

## 一、为什么不能「编译」

微信小程序用 **WXML / WXSS**,抖音用 **TTML / TTSS**。
两者是不同运行时与组件模型,没有工具能把 WXML 编译成 TTML。

主流做法是用 Taro / uni-app 在**构建时生成两套产物**,
代价是页面代码必须改写成框架语法,不能直接写原生语法。

本项目现状:8 个页面全是原生 WXML,所以没有"多打一个 target"这条路。

---

## 二、好消息:core 完全不用改

`packages/core/` 约 1500 行,**不碰任何平台 API**。
依赖的 5 个接口已抽象好:

```
KeyValueStore  ·  Scanner  ·  Clipboard  ·  CryptoRandom  ·  SyncTransport
```

只要新端实现这 5 个适配器,以下内容**一行都不用改**:

- TOTP / HOTP 取码
- AES-256-GCM 加解密、PBKDF2 派生
- 保险库业务逻辑、自动锁定
- LWW-Element-Set 冲突合并
- 恢复码、Google Authenticator 迁移
- 审计日志

并且能直接复用 `packages/core/test/crossplatform.test.mjs` 验证一致性 ——
把比对对象换成新端产物即可。

这是当初把适配层抽出来的回报。

---

## 三、平台 API 对照表(抖音)

| 能力 | 微信 | 抖音 | 结论 |
| --- | --- | --- | --- |
| 存储 | `wx.setStorageSync` | `tt.setStorageSync` | 直接映射 |
| 扫码 | `wx.scanCode` | `tt.scanCode` | 需改,见下 |
| 剪贴板 | `wx.setClipboardData` | `tt.setClipboardData` | 直接映射 |
| 随机数 | `wx.getRandomValues(Uint8Array)` **同步** | `tt.getRandomValues({length})` **异步** | **签名不兼容** |
| 文件系统 | `wx.getFileSystemManager` | `tt.getFileSystemManager` | 需核实 |
| 登录 | `wx.login` | `tt.login` | 身份体系不同,需后端配合 |

### 3.1 随机数:最棘手的一处

```javascript
// 微信:同步,原地填充,返回 Uint8Array
const filled = wx.getRandomValues(out);

// 抖音:异步,基础库 2.87.0+,返回 ArrayBuffer
tt.getRandomValues({ length: 32, success: (res) => res.randomValues })
```

`CryptoRandom.bytes(length): Uint8Array` 是**同步接口**。

三种应对:

| 方案 | 代价 |
| --- | --- |
| 改 core 为async | 波及所有密码学调用点,且 `Web Crypto` 侧同步实现不一致 |
| **启动时预取随机字节池,用完异步补** | **不动 core,推荐** |
| 让框架把异步变同步 | 会阻塞 UI 线程导致卡死,不可行 |

**绝对不能退回 `Math.random()` 兜底** —— 会让 GCM nonce 可预测,摧毁加密强度。
缺随机源时应当直接报错。

### 3.2 扫码:能力有缺口

抖音官方文档明确写着:

- 暂不支持 `onlyFromCamera` 和 `scanType`
- 返回值不支持 `charSet`、`path`、`rawData`
- GBK 编码的二维码会乱码
- 用户取消的错误码是 `116295`(微信是 `errMsg` 含 `cancel`)
- **要求在隐私协议中声明对应能力**,否则报 `116279`

最后一条不是写代码能解决的,需在开发者后台配置。

---

## 四、为什么不用 Taro / uni-app

已评估并否决。三条理由:

### 4.1 框架解决不了我们真正依赖的差异

跨端框架的目标是抹平 80% 的**模板语法**差异。
但本项目最依赖的恰恰是剩余 20%:加密随机数、扫码能力、身份体系。

且框架自身在这条 API 上就有bug —— Taro 的
`getUserCryptoManager().getRandomValues` 在微信端 `await` 会返回 `undefined`
(官方 issue #13673,TS 类型也缺 `randomValues` 字段)。

### 4.2 体积与性能都是净损失

小程序主包限制 2MB。实测数据:

| 方案 | 包体积增量 | 加上 core(54 KB)后 | 列表 FPS | 内存 |
| --- | --- | --- | --- | --- |
| 原生(现状) | 0 KB | 54 KB | 58-60 | 45 MB |
| uni-app | +80~120 KB | ~170 KB | 55-58 | 62 MB |
| Taro 3 | +150~200 KB | ~250 KB | 53-57 | 68 MB |

本应用是**高频刷新的倒计时列表**(每秒重算 TOTP + 重渲染进度条),
恰好是跨端框架最吃亏的场景 —— Taro 3 的运行时方案要在小程序里模拟 DOM,`setData` 数据量更大。

对 2FA 这种"打开就要立刻看到码"的工具,牺牲 FPS 换多端,方向是反的。

### 4.3 框架的收益我们已经不需要了

普通业务项目跨端,难的是把业务逻辑和平台 API 搅在一起的代码拆开。
**这件事本项目已经做完了。**

要复用的页面逻辑不到 300 行,且本来就是 TS,新端直接跑;
只有 WXML 模板要重写。框架能省的,恰是已经不需要花的那部分。

---

## 五、若仍要上抖音:建议做法

```
packages/core/          零改动
apps/weixin/            零改动(现 apps/miniprogram)
apps/douyin/            新增
├── platform.ts         5 个适配器,约 250 行
├── pages/*.ttml        8 个模板,约 700 行
└── 页面 TS 逻辑         从现有页面复制,基本不改
```

优势:

- 微信端完全不受影响
- 体积只增加抖音端部分
- 可复用 `crossplatform.test.mjs` 验证一致性
- 单个平台出问题不影响其他平台

预估工作量:**适配器 1 天 + 模板 1.5 天**。

对比改造成 Taro(重写 8 个页面为 JSX + 迁移构建链),
后者工作量大、产物更大、性能更差。

---

## 六、什么情况下才该改用跨端框架

记录反向条件,避免日后反复讨论:

- 平台数 **≥ 4** —— 维护 4 套模板的边际成本会超过抽象成本
- 团队是 Vue 栈且已有 uni-app 项目 —— 迁移成本比新建低
- 需要同时出 H5 / App,而不只是小程序

当前只有微信 + 可能的抖音,离框架经济性临界点尚远。

---

## 七、其他平台待查清单

若日后扩展,需逐一核实(本项目实际用到的部分):

- [ ] 支付宝:`my.*`,有无 `getRandomValues`,取消扫码的错误码
- [ ] 快应用:文件后缀与 API 命名
- [ ] 百度、QQ 小程序
- [ ] 各平台的小程序代码包体积上限(均 2MB?)
- [ ] 各平台对 `AES-GCM` / 长时运算的JIT 限制 —— 21 万轮 PBKDF2 在低端机上的耗时
