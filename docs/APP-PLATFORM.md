# App / H5 端框架选型

针对"后续做成 App + H5"的选型判断。结论基于本仓库实测,
不是通用框架对比。

## 结论先行

| 目标端 | 建议 | 理由 |
| --- | --- | --- |
| **H5** | 现有 Web 端直接复用,不动 | core 零平台依赖,已有 fetch 同步实现 |
| **App(原生壳)** | **Capacitor**,不选 Taro/uni-app | 见下文三条实测依据 |
| 若必须 React Native | 裸 RN + `@noble/hashes`,不用 Expo 生态做加密 | 加密随机数在 RN 上有坑 |

**核心判断:这个项目需要的不是跨端框架,是"同一份 core 接到不同宿主"。**
core 2368 行零平台 API,已经是最有价值的资产 ——
框架能省的恰是已经不需要省的。

---

## 一、为什么 Taro / uni-app 不适合(三条实测依据)

### 1. 最难的部分恰是框架不管的那 20%

框架解决的是**模板语法**差异。但本项目最依赖的三个能力,框架都覆盖不到:

| 能力 | 现状 | 框架能否解决 |
| --- | --- | --- |
| 加密随机数 | `defaultRandom` 已做多级回退 | **不能** |
| 扫码 | 各端 API 差异大 | 不能 |
| 身份体系 | 各端完全不同 | 不能 |

而且框架自己在这上面就有坑:uni-app 移植到 H5 需另配自定义插件
承载 `uni.scanCode` 与 `uni.getRandomValues`;
Taro 自己的 `getUserCryptoManager().getRandomValues` 在微信端
`await` 返回 `undefined`(官方 issue #13673)。

**实测代价**(上一轮记录):uni-app +80~120KB / Taro 3 +150~200KB,
列表 FPS 从 58-60 掉到 53-57。

而本应用是**每秒重算 TOTP 的高频刷新列表** —— 正是框架最吃亏的场景。
丢 3-7 帧在滚动列表上是能直接感知到的卡顿。

### 2. 异步/同步的鸿沟框架填不了

`deriveKey` 是**同步**接口。抖音 `tt.getRandomValues` 是异步的。
框架无法把异步变同步 —— 强行阻塞 UI 线程是更糟的选择。

### 3. 加密随机数在跨端框架上不可移植(本轮新发现,最关键)

Taro 自己的 `getUserCryptoManager().getRandomValues` 在微信端
`await` 返回 `undefined`(见上)。这说明**框架抽象层在加密原语上不可靠**。
对一个"零信任"的 2FA 工具,随机数不可靠是致命的 ——
随机数 Predictable 意味着密文可被伪造。

---

## 二、为什么推荐 Capacitor

### 关键前提:core 已零平台依赖

```
packages/core/src/  2368 行
  - adapters/platform.ts   定义契约,各端实现
  - sync/httpTransport.ts  用标准 globalThis.fetch
  - crypto/primitives.ts   随机数已多级回退
```

实测 `grep "wx\.|tt\.|chrome\.|window\." packages/core/src/` →
**零命中**(仅注释提及)。这不是巧合,是刻意的架构约束。

### Capacitor 的优势:它是"壳",不是"框架"

| 维度 | 影响 |
| --- | --- |
| core 零改动 | 打包进 WebView,直接跑 |
| 同步走原生 HTTP | Capacitor 插件可替换 `fetch`,绕开 WebView 的 CORS |
| 密钥存 Keychain/Keystore | 用官方插件,不放 localStorage |
| 生物识别解锁 | 官方支持,且是 2FA 工具的刚需 |
| 构建产物 | APK/IPA,一套 Web 代码 |

**H5 与 App 可共用同一份产物** —— 这正是"跨端"的真正含义。

### Capacitor 的代价(诚实列出)

1. **WebView 性能天花板**:高频列表 + 650ms 阻塞(见下节)。
   需要优化解锁流程的感知体验。
2. **体积**:比原生大,但比 Taro/uni-app 的跨端编译产物小得多
   (因为不引入编译层运行时)。
3. **iOS 必须用 Mac 构建**:这是硬约束,需提前告知用户。
4. **不解决 App Store 上架资质**:需要开发者账号,
   2FA 工具可能需要隐私政策 + 出口合规声明。

---

## 三、实测数据:一个必须正视的性能问题

本项目用 **PBKDF2-SHA256,210,000 轮**(`PBKDF2_ITERATIONS`),
由 `@noble/hashes` 纯 JS 实现。

本轮实测(同一台机器,Node 22):

| 实现 | 耗时 | 折合 60fps 帧预算 |
| --- | --- | --- |
| 纯 JS(`@noble/hashes`) | **790 ms** | 47 帧 |
| 原生(Web Crypto / 原生 API) | **135 ms** | 8 帧 |
| **加速比** | **5.9 倍** | |

### 这意味着什么

**650ms 级别的同步阻塞会卡住主线程。** 解锁按钮按下后,
动画会明显停顿,小程序/WebView 主线程在此期间无响应。

这不是"未来优化项",而是**决定框架选型的因素**:

- Taro/uni-app 的编译层不会让纯 JS 的 PBKDF2 变快 —— 慢的是算法本身。
- Capacitor 也不行 —— 同样是 WebView。
- **唯一能解决的是换用原生加密 API。**

### 三个层次的解法(按推荐度)

1. **换成平台原生 KDF**(最彻底)
   Web 端有 `crypto.subtle`(`PBKDF2` 是 Web Crypto 一等公民),
   App 壳里也有原生插件。实测 135ms,可接受。
   `defaultRandom` 已经是这个模式(先试原生再回退),KDF 应照做。
   ⚠️ 但**换算法不影响密文格式** —— `Envelope` 里存了
   `kdf` 和 `iterations` 字段,本就是为平滑迁移预留的。

2. **放进 Worker**(缓解卡顿)
   小程序有 Worker,Web 有 Web Worker。
   把 KDF 移出主线程,配合加载动画,感知上可接受。
   **改动最小,建议先做这个。**

3. **降低迭代次数**(不推荐)
   210k 是安全余量,砍它等于降低抗爆破能力。
   移动端有原生加速(实测快 5.9 倍),所以**并不需要砍**。

**建议顺序:先做 2(Worker,一天内可完成),观察体验;
若仍不够再上 1。**

---

## 四、如果要考虑 React Native

用户若更看重原生手感而非复用代码,RN 是合法选择。但要清楚代价:

| 项 | 说明 |
| --- | --- |
| core 复用 | 需要编译到 Hermes,`@noble/hashes` 可用 |
| 加密随机数 | **有坑**:`crypto.getRandomValues` 在 RN 上需 polyfill,<br>Hermes 不完整实现 Web Crypto,必须用 `react-native-get-random-values` |
| 存储 | 换 `react-native-keychain`,不能用 AsyncStorage 存密钥 |
| 扫码 | 需 `vision-camera` + 权限处理 |
| 开发成本 | **需重写全部 UI**(与小程序/Web 无代码复用) |

**关键判断:选 RN 等于放弃已有的 8 个页面和三端同步能力。**
`core` 能复用(这是核心价值),但 UI 层从零开始。

只有在"原生手感优先于开发效率"这个前提明确时才选。

---

## 五、建议的推进顺序

```
1. H5  ──→  现有 Web 端直接部署,零改动
              (先验证 H5 独立可用,这是最快的可用产物)

2. App ──→  Capacitor 壳 + core 原样打包
              配 Keychain 插件存密钥 + 生物识别
              同期做 KDF Worker 化(解决 650ms 阻塞)

3. 加密原生化 ──→ 有原生 KDF 后,再谈 Taro/uni-app 才有意义
```

**反过来的顺序(先选框架再优化加密)是错的** ——
因为慢的是 PBKDF2 纯 JS 实现,不是模板层,
选任何跨端框架都不会让它变快。

---

## 六、遗留决策(需用户拍板)

1. **H5 与现有 Web 端的关系**:同一份部署,还是独立站?
   (影响是否需要处理"Web 端已有扩展"的双轨问题)
2. **iOS 构建设备**:有没有 Mac?没有的话 iOS 只能靠云构建服务。
3. **KDF 优化优先级**:Worker 化(小改动)还是直接上原生 KDF(大改动)?
4. **是否要 React Native**:这决定 UI 层是否重写,越早定越好。
