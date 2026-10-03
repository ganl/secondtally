/**
 * 小程序的类型声明。
 *
 * 只声明微信提供的全局对象;core 与 platform 的类型由 build-miniprogram.mjs
 * 生成的 core.d.mts / platform.d.mts 提供(它们重新导回TypeScript 源码),
 * 因此这里不要手写转发声明——core 一改就会漏。
 *
 * 两个关键约定(都是踩过才知道):
 * 1. getApp 必须带泛型签名。写成 any 之后,`getApp<MyApp>()` 会报
 *    "Untyped function calls may not accept type arguments",
 *    因为所有页面都用泛型来拿带类型的 globalData。
 * 2. 微信的回调事件类型在 WechatMiniprogram 命名空间下,与全局 wx 不是一回事。
 */

/** 微信 API 对象。 */
declare const wx: any;

/** 微信 API 的返回类型命名空间,页面用它标注回调参数。 */
declare namespace WechatMiniprogram {
  interface GetSystemInfoSyncResult {
    brand: string;
    model: string;
    platform: string;
  }

  /** input 事件对象。detail.value 恒为字符串。 */
  interface Input {
    detail: { value: string; cursor?: number };
  }

  /** picker 组件的 change 事件。 */
  interface PickerChange {
    detail: { value: string | number | string[] };
  }

  /** 触摸事件。 */
  interface TouchEvent {
    detail: {
      changedTouches: Array<{ clientX: number; clientY: number; identifier: number }>;
    };
    currentTarget: { id: string; dataset: Record<string, unknown> };
    target: { id: string; dataset: Record<string, unknown> };
  }
}

/** 取App 实例。泛型形参让页面拿到带类型的 globalData。 */
declare function getApp<T = Record<string, unknown>>(): T;

declare function App(options: {
  onLaunch?(): void | Promise<void>;
  onShow?(): void;
  onHide?(): void;
  globalData: Record<string, unknown>;
  [key: string]: unknown;
}): void;

declare function Page(options: {
  data?: Record<string, unknown>;
  [key: string]: unknown;
}): void;

declare function getCurrentPages(): Array<{ route: string; data: Record<string, unknown> }>;
declare function Component(options: Record<string, unknown>): void;
