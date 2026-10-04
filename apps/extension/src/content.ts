/**
 * 内容脚本:在登录页把验证码填进去。
 *
 * 触发路径有两条:
 * 1. 页面加载与 DOM 变化时自动填充。
 * 2. 用户点扩展图标时,由弹窗主动请求填充。
 *
 * 为什么不能只在页面加载时填一次:
 * 大量登录页(尤其是 SPA)是加载后才渲染表单,
 * 内容脚本执行时 DOM 里还不存在输入框。
 * 所以用 MutationObserver 持续观察,出现候选输入框就补一次。
 *
 * 安全考量:内容脚本运行在页面上下文,页面脚本能观察到我们填入的值。
 * 这是自动填充的固有代价,无法通过技术手段消除。缓解方式:
 * - 只填当前可见的验证码,不缓存、不上报
 * - 定期清空已过期的输入框,缩小被页面脚本读到的窗口
 */

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        cb: (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean | void,
      ): void;
    };
  };
};

interface CodePayload {
  code: string;
  remaining: number;
}

/** 提示词匹配:覆盖中英文的常见验证码命名。 */
const HINT_PATTERN =
  /验证码|校验码|动态码|动态密码|短信码|one.?time|otp|verif|auth.?code|security.?code|mfa|2fa/;

/** 结构性选择器:属性层面就能确定是验证码输入框,最可靠。 */
const STRUCTURAL_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[autocomplete="otp"]',
  'input[name*="otp" i]',
  'input[name*="one-time" i]',
  'input[name*="totp" i]',
  'input[name*="authcode" i]',
  'input[name*="verifycode" i]',
  'input[name*="verification" i]',
  'input[id*="otp" i]',
  'input[id*="2fa" i]',
  'input[id*="mfa" i]',
];

/** 同一元素在 REPEAT_WINDOW_MS 内不重复填相同值,避免触发页面的重复提交校验。 */
const REPEAT_WINDOW_MS = 30_000;

/** 已填内容在此时长后从输入框移除。 */
const CLEAR_AFTER_MS = 30_000;

const lastFilled = new Map<HTMLInputElement, { code: string; at: number }>();

function isVisible(el: HTMLInputElement): boolean {
  if (el.disabled || el.readOnly || el.type === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function hintMatches(el: HTMLInputElement): boolean {
  const hint = [
    el.name,
    el.id,
    el.placeholder,
    el.getAttribute('aria-label') ?? '',
    el.title,
  ]
    .join(' ')
    .toLowerCase();
  return HINT_PATTERN.test(hint);
}

function findTargets(): HTMLInputElement[] {
  const found = new Set<HTMLInputElement>();
  for (const selector of STRUCTURAL_SELECTORS) {
    document.querySelectorAll<HTMLInputElement>(selector).forEach((el) => found.add(el));
  }
  // 兜底:靠提示文字识别,但只考虑数字键盘的输入框,避免误填到手机号等字段
  document
    .querySelectorAll<HTMLInputElement>('input[inputmode="numeric"], input[type="tel"], input[type="number"]')
    .forEach((el) => {
      if (hintMatches(el)) found.add(el);
    });
  return Array.from(found).filter(isVisible);
}

/**
 * 赋值并派发事件。
 *
 * 用原生 setter 而不是 `el.value = code`:部分框架(React 等)
 * 会在 value 的 setter 上挂自己的值追踪,直接赋值会被它们的状态覆盖回去,
 * 必须绕过实例属性、调用原型上的原生 setter 才能让框架感知到变化。
 *
 * 只派发 input 与 change,不伪造 KeyboardEvent:多数站点监听这两个事件就够,
 * 伪造键盘事件反而可能命中它们的反自动化逻辑。
 */
function assign(el: HTMLInputElement, code: string): boolean {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(el, code);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function scheduleClear(el: HTMLInputElement, code: string): void {
  setTimeout(() => {
    if (!el.isConnected) return;
    // 用户已经手动改过内容就不要覆盖
    if (el.value !== code) return;
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    lastFilled.delete(el);
  }, CLEAR_AFTER_MS);
}

interface FillResponse {
  ok: boolean;
  data?: CodePayload[];
  error?: string;
}

async function fetchCodes(): Promise<CodePayload[]> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'twofa:fillAll' })) as FillResponse;
    return response.ok && Array.isArray(response.data) ? response.data : [];
  } catch {
    // 后台 service worker 可能正在重启,静默失败即可,下一次观察会重试
    return [];
  }
}

/** 返回本次是否真的填入了内容。 */
async function tryFill(): Promise<boolean> {
  const targets = findTargets();
  if (targets.length === 0) return false;

  const codes = await fetchCodes();
  if (codes.length === 0) return false;

  // 一个输入框只填一个码。若有多个匹配,取剩余有效期最短的——最紧迫的那个。
  const primary = codes.reduce((best, cur) => (cur.remaining < best.remaining ? cur : best));

  let filled = false;
  for (const el of targets) {
    const previous = lastFilled.get(el);
    if (previous && previous.code === primary.code && Date.now() - previous.at < REPEAT_WINDOW_MS) {
      continue;
    }
    if (assign(el, primary.code)) {
      lastFilled.set(el, { code: primary.code, at: Date.now() });
      scheduleClear(el, primary.code);
      filled = true;
    }
  }
  return filled;
}

const observer = new MutationObserver(() => {
  void tryFill();
});

function start(): void {
  observer.observe(document.documentElement, { childList: true, subtree: true });
  void tryFill();

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    const type = (msg as { type?: string } | null)?.type;
    if (type !== 'twofa:page:fill') return false;
    tryFill()
      .then((ok) => respond({ ok }))
      .catch(() => respond({ ok: false }));
    return true;
  });
}

if (document.documentElement) {
  start();
} else {
  document.addEventListener('DOMContentLoaded', start, { once: true });
}
