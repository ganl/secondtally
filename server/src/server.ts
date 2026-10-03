/**
 * HTTP 服务。
 *
 * 用 Node 内置 http 而非 Express/Fastify:本项目只有 6 个端点,
 * 引入框架带来的依赖体积与供应链风险大于收益。
 *
 * 安全要点:
 * - CORS 使用显式来源白名单,生产环境禁止通配符。
 * - 访问令牌走 Authorization 头,绝不放 URL 查询参数
 *   (URL 会被浏览器历史、Referer、日志系统记录)。
 * - 统一 JSON 错误结构,不返回堆栈。
 * - 基础限流,防止撞库。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.js';
import { VaultRepository } from './repository.js';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  tokenSecret: string;
  /** 允许的跨域来源。CORS 白名单。 */
  allowedOrigins: string[];
  /** 访问令牌有效期(秒)。 */
  accessTokenTtl: number;
  /** 是否为生产环境。 */
  isProduction: boolean;
}

export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** 结构化 JSON 日志,带请求 ID 便于串联一次请求的完整链路。 */
export function createLogger(): Logger {
  const emit = (level: string, msg: string, meta?: unknown) => {
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(meta && typeof meta === 'object' ? (meta as object) : {}),
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
  return {
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB,保险库密文远小于此

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class AegiServer {
  private readonly server;
  private readonly auth: AuthService;
  private readonly repo: VaultRepository;
  private readonly logger: Logger;
  private rateLimits = new Map<string, RateLimitEntry>();

  constructor(
    private readonly config: ServerConfig,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger();
    this.auth = new AuthService(`${config.dataDir}/credentials.json`, config.tokenSecret);
    this.repo = new VaultRepository(`${config.dataDir}/vaults.db`);
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        this.logger.info('aegis 同步服务已启动', {
          host: this.config.host,
          port: this.config.port,
          env: this.config.isProduction ? 'production' : 'development',
          corsOrigins: this.config.allowedOrigins,
        });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.repo.close();
    this.logger.info('服务已停止');
  }

  // ---------- 基础工具 ----------

  private applyHeaders(req: IncomingMessage, res: ServerResponse, requestId: string) {
    // CORS:显式白名单。生产环境不允许 '*'。
    const origin = req.headers.origin;
    if (origin && this.config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }

    // 安全头
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Request-Id', requestId);
    // 本服务只返回 JSON,禁止任何形式的缓存,避免密文被中间层留存
    res.setHeader('Cache-Control', 'no-store');
  }

  private json(res: ServerResponse, status: number, body: unknown, requestId: string) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'X-Request-Id': requestId,
    });
    res.end(payload);
  }

  private fail(res: ServerResponse, status: number, code: string, message: string, requestId: string) {
    this.json(res, status, { error: { code, message, requestId } }, requestId);
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private readJson<T>(raw: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error('请求体不是合法 JSON');
    }
  }

  /** 限流。登录类端点用较严的阈值。 */
  private checkRateLimit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(key);
    if (!entry || entry.resetAt < now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  private clientKey(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]!.trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** 从 Authorization 头提取并校验令牌。URL 参数一律不采信。 */
  private authenticate(req: IncomingMessage): { userId: string; deviceId: string } | null {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    return this.auth.verifyAccessToken(token, this.config.tokenSecret);
  }

  // ---------- 路由 ----------

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const requestId = randomUUID();
    this.applyHeaders(req, res, requestId);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (path === '/health') {
        this.json(res, 200, { status: 'ok', uptime: Math.floor(process.uptime()) }, requestId);
        return;
      }

      if (path === '/ready') {
        // 真正检查依赖:能查到库说明 SQLite 可用
        try {
          this.repo.get('__probe__');
          this.json(res, 200, { status: 'ready', storage: 'ok' }, requestId);
        } catch (error) {
          this.fail(res, 503, 'STORAGE_UNAVAILABLE', '存储不可用', requestId);
        }
        return;
      }

      if (path === '/api/v1/auth/register' && req.method === 'POST') {
        await this.handleRegister(req, res, requestId);
        return;
      }

      if (path === '/api/v1/auth/login' && req.method === 'POST') {
        await this.handleLogin(req, res, requestId);
        return;
      }

      if (path === '/api/v1/auth/refresh' && req.method === 'POST') {
        await this.handleRefresh(req, res, requestId);
        return;
      }

      if (path === '/api/v1/vault' && req.method === 'GET') {
        await this.handlePull(req, res, requestId);
        return;
      }

      if (path === '/api/v1/vault' && req.method === 'PUT') {
        await this.handlePush(req, res, requestId);
        return;
      }

      if (path === '/api/v1/sync-log' && req.method === 'GET') {
        this.handleSyncLog(req, res, requestId);
        return;
      }

      this.fail(res, 404, 'NOT_FOUND', '端点不存在', requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      this.logger.error('请求处理失败', { requestId, path, error: message });
      // 不把内部错误细节返回给客户端
      this.fail(res, 500, 'INTERNAL_ERROR', '服务器内部错误', requestId);
    }
  }

  private async handleRegister(req: IncomingMessage, res: ServerResponse, requestId: string) {
    if (!this.checkRateLimit(`register:${this.clientKey(req)}`, 5, 60 * 60 * 1000)) {
      this.fail(res, 429, 'RATE_LIMITED', '注册过于频繁,请稍后再试', requestId);
      return;
    }

    const body = this.readJson<{ userId?: string; password?: string }>(await this.readBody(req));
    if (!body.userId || !body.password) {
      this.fail(res, 400, 'BAD_REQUEST', '缺少 userId 或 password', requestId);
      return;
    }

    const userId = this.auth.register(body.userId, body.password);
    if (!userId) {
      this.fail(res, 409, 'ALREADY_EXISTS', '该账户已存在,请直接登录', requestId);
      return;
    }

    this.logger.info('新用户注册', { userId, requestId });
    this.json(
      res,
      201,
      {
        userId,
        accessToken: this.auth.issueAccessToken(userId, 'initial', this.config.tokenSecret, this.config.accessTokenTtl),
        refreshToken: this.auth.issueRefreshToken(userId),
        expiresIn: this.config.accessTokenTtl,
      },
      requestId,
    );
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse, requestId: string) {
    const key = `login:${this.clientKey(req)}`;
    if (!this.checkRateLimit(key, 10, 15 * 60 * 1000)) {
      this.fail(res, 429, 'RATE_LIMITED', '登录尝试过多,请稍后再试', requestId);
      return;
    }

    const body = this.readJson<{ userId?: string; password?: string }>(await this.readBody(req));
    if (!body.userId || !body.password) {
      this.fail(res, 400, 'BAD_REQUEST', '缺少 userId 或 password', requestId);
      return;
    }

    if (!this.auth.verify(body.userId, body.password)) {
      // 不区分"用户不存在"与"密码错误",避免账户枚举
      this.logger.warn('登录失败', { userId: body.userId, requestId });
      this.fail(res, 401, 'INVALID_CREDENTIALS', '账户或密码错误', requestId);
      return;
    }

    const userId = body.userId.trim();
    this.json(
      res,
      200,
      {
        userId,
        accessToken: this.auth.issueAccessToken(userId, 'login', this.config.tokenSecret, this.config.accessTokenTtl),
        refreshToken: this.auth.issueRefreshToken(userId),
        expiresIn: this.config.accessTokenTtl,
      },
      requestId,
    );
  }

  private async handleRefresh(req: IncomingMessage, res: ServerResponse, requestId: string) {
    const body = this.readJson<{ userId?: string; refreshToken?: string }>(await this.readBody(req));
    if (!body.userId || !body.refreshToken) {
      this.fail(res, 400, 'BAD_REQUEST', '缺少 userId 或 refreshToken', requestId);
      return;
    }

    const result = this.auth.refresh(body.userId.trim(), body.refreshToken);
    if (!result) {
      this.fail(res, 401, 'INVALID_REFRESH_TOKEN', '登录已过期,请重新登录', requestId);
      return;
    }
    this.json(res, 200, { ...result, expiresIn: this.config.accessTokenTtl }, requestId);
  }

  private async handlePull(req: IncomingMessage, res: ServerResponse, requestId: string) {
    const auth = this.authenticate(req);
    if (!auth) {
      this.fail(res, 401, 'UNAUTHORIZED', '请先登录', requestId);
      return;
    }

    const record = this.repo.get(auth.userId);
    if (!record) {
      this.json(res, 200, { record: null }, requestId);
      return;
    }

    this.json(
      res,
      200,
      {
        record: {
          envelope: JSON.parse(record.envelope),
          revision: record.revision,
          updatedAt: record.updatedAt,
          deviceId: record.deviceId,
        },
      },
      requestId,
    );
  }

  private async handlePush(req: IncomingMessage, res: ServerResponse, requestId: string) {
    const auth = this.authenticate(req);
    if (!auth) {
      this.fail(res, 401, 'UNAUTHORIZED', '请先登录', requestId);
      return;
    }

    if (!this.checkRateLimit(`push:${auth.userId}`, 60, 60 * 1000)) {
      this.fail(res, 429, 'RATE_LIMITED', '同步过于频繁', requestId);
      return;
    }

    const body = this.readJson<{
      envelope?: unknown;
      updatedAt?: number;
      deviceId?: string;
      baseRevision?: number | null;
    }>(await this.readBody(req));

    if (!body.envelope || typeof body.updatedAt !== 'number') {
      this.fail(res, 400, 'BAD_REQUEST', '缺少 envelope 或 updatedAt', requestId);
      return;
    }

    const baseRevision =
      body.baseRevision === null || body.baseRevision === undefined ? null : Number(body.baseRevision);
    const envelopeJson = JSON.stringify(body.envelope);

    const result = this.repo.put(
      auth.userId,
      envelopeJson,
      body.updatedAt,
      String(body.deviceId ?? 'unknown').slice(0, 64),
      baseRevision,
    );

    if (result.ok) {
      this.logger.info('同步上传成功', {
        userId: auth.userId,
        revision: result.revision,
        bytes: envelopeJson.length,
        requestId,
      });
      this.json(res, 200, { ok: true, revision: result.revision }, requestId);
      return;
    }

    // 冲突:返回当前记录,让客户端合并后重试。绝不静默覆盖。
    const current = this.repo.get(auth.userId);
    this.logger.warn('同步冲突', { userId: auth.userId, requestId });
    this.json(
      res,
      409,
      {
        ok: false,
        conflict: current
          ? {
              envelope: JSON.parse(current.envelope),
              revision: current.revision,
              updatedAt: current.updatedAt,
              deviceId: current.deviceId,
            }
          : null,
      },
      requestId,
    );
  }

  private handleSyncLog(req: IncomingMessage, res: ServerResponse, requestId: string) {
    const auth = this.authenticate(req);
    if (!auth) {
      this.fail(res, 401, 'UNAUTHORIZED', '请先登录', requestId);
      return;
    }
    // 只返回元数据(设备、版本、时间、字节数),不含任何内容
    this.json(res, 200, { syncs: this.repo.recentSyncs(auth.userId) }, requestId);
  }
}
