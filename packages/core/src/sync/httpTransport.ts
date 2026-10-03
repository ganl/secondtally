/**
 * 同步客户端 —— 三端共用。
 *
 * 职责边界:本文件只负责"搬运密文"与"维护登录态",
 * 完全不接触、也无法解读保险库内容。
 * 解密能力在 core 中,需要用户主密码才能触发。
 *
 * 401 自动刷新重试:并发请求同时 401 时,
 * 用同一个 in-flight Promise 避免触发多次刷新
 * (刷新令牌是一次性的,并发刷新会让除首个外的全部失败)。
 */

import type { PushPayload, PushResult, RemoteRecord, SyncTransport } from '../adapters/platform.js';

export interface HttpTransportOptions {
  baseUrl: string;
  userId: string;
  /** 读取持久化的登录态。 */
  loadSession: () => { accessToken: string; refreshToken: string } | null;
  /** 保存登录态。 */
  saveSession: (session: { accessToken: string; refreshToken: string }) => void | Promise<void>;
  /** 清除登录态。 */
  clearSession: () => void | Promise<void>;
  /** 网络请求。默认使用 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** 登录态失效时的回调,用于跳回登录页。 */
  onSessionExpired?: () => void;
}

interface ApiError {
  error: { code: string; message: string; requestId?: string };
}

export class HttpSyncTransport implements SyncTransport {
  private inFlightRefresh: Promise<boolean> | null = null;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new Error('当前环境不支持 fetch,无法同步');
    }
    // 小程序环境下 bind 一下,避免 Illegal invocation
    this.doFetch = options.fetchImpl ? impl : impl.bind(globalThis);
  }

  private url(path: string): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; auth?: boolean } = { method: 'GET' },
    allowRetry = true,
  ): Promise<T> {
    const session = init.auth ? this.options.loadSession() : null;
    if (init.auth && !session) {
      throw new Error('尚未登录同步服务');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // 令牌只走 Authorization 头,绝不放 URL——URL 会被日志与 Referer 记录
    if (session) headers.Authorization = `Bearer ${session.accessToken}`;

    let response: Response;
    try {
      response = await this.doFetch(this.url(path), {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      // 区分网络故障与业务错误,前者通常可重试
      throw new Error(
        `网络请求失败,请检查网络后重试(${error instanceof Error ? error.message : '未知原因'})`,
      );
    }

    if (response.status === 401 && allowRetry) {
      const refreshed = await this.refreshSession();
      if (refreshed) {
        return this.request<T>(path, init, false);
      }
      this.options.onSessionExpired?.();
      throw new Error('登录已过期,请重新登录同步账户');
    }

    if (!response.ok) {
      let detail: ApiError | null = null;
      try {
        detail = (await response.json()) as ApiError;
      } catch {
        /* 响应体不是 JSON,用通用文案 */
      }
      const message = detail?.error?.message ?? `服务端返回 ${response.status}`;
      throw new Error(message);
    }

    return (await response.json()) as T;
  }

  /**
   * 刷新登录态。并发调用共享同一个 Promise——
   * 刷新令牌是一次性消耗品,并发刷新会导致除首个外全部失败,
   * 用户表现为"刚登录就又被踢出"。
   */
  private async refreshSession(): Promise<boolean> {
    if (this.inFlightRefresh) return this.inFlightRefresh;

    this.inFlightRefresh = (async () => {
      const session = this.options.loadSession();
      if (!session) return false;
      try {
        const result = await this.request<{ accessToken: string; refreshToken: string }>(
          '/api/v1/auth/refresh',
          { method: 'POST', body: { userId: this.options.userId, refreshToken: session.refreshToken } },
          false,
        );
        await this.options.saveSession(result);
        return true;
      } catch {
        await this.options.clearSession();
        return false;
      } finally {
        this.inFlightRefresh = null;
      }
    })();

    return this.inFlightRefresh;
  }

  // ---- SyncTransport 实现 ----

  async pull(_sinceRevision: number | null): Promise<RemoteRecord | null> {
    const result = await this.request<{ record: RemoteRecord | null }>('/api/v1/vault', { method: 'GET', auth: true });
    return result.record;
  }

  async push(payload: PushPayload): Promise<PushResult> {
    try {
      const result = await this.request<{ ok: boolean; revision: number }>('/api/v1/vault', {
        method: 'PUT',
        body: payload,
        auth: true,
      });
      return { ok: result.ok, revision: result.revision, conflict: null };
    } catch (error) {
      // 409 表示版本冲突,交给 core 去合并重试
      if (error instanceof Error && /服务端返回 409/.test(error.message)) {
        const conflict = await this.pull(null);
        return { ok: false, revision: 0, conflict };
      }
      throw error;
    }
  }

  // ---- 登录相关 ----

  async register(password: string): Promise<void> {
    const result = await this.request<{ accessToken: string; refreshToken: string }>(
      '/api/v1/auth/register',
      { method: 'POST', body: { userId: this.options.userId, password } },
    );
    await this.options.saveSession(result);
  }

  async login(password: string): Promise<void> {
    const result = await this.request<{ accessToken: string; refreshToken: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: { userId: this.options.userId, password },
    });
    await this.options.saveSession(result);
  }

  async logout(): Promise<void> {
    await this.options.clearSession();
  }

  isLoggedIn(): boolean {
    return this.options.loadSession() !== null;
  }

  async fetchSyncLog(): Promise<Array<{ deviceId: string; revision: number; bytes: number; at: number }>> {
    const result = await this.request<{ syncs: Array<{ deviceId: string; revision: number; bytes: number; at: number }> }>(
      '/api/v1/sync-log',
      { method: 'GET', auth: true },
    );
    return result.syncs;
  }
}
