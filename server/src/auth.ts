/**
 * 服务端身份认证。
 *
 * 核心安全设计:服务端身份与主密码严格分离。
 *
 * - 服务端身份(本文件)只用于"识别这是哪个用户的哪台设备",
 *   作用是决定把哪份密文发给谁。
 * - 主密码(from master password)只存在于客户端,用于加解密保险库。
 *   服务端从不接收、从不存储、也永远无法得知。
 *
 * 因此:即使数据库整体被脱库,攻击者拿到的也只是密文;
 * 若再叠加主密码强度足够,用户的 TOTP 种子依然安全。
 *
 * 反过来也要说清风险:如果主密码太弱,攻击者可以离线爆破密文。
 * 客户端的密码强度校验与 21 万次 PBKDF2 就是为抬高这个成本而存在。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 口令哈希。服务端存的是 scrypt 派生值,不是明文。 */
export interface StoredCredential {
  userId: string;
  salt: string;
  hash: string;
  createdAt: number;
}

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
}

export class AuthService {
  private users = new Map<string, StoredCredential>();
  /** userId -> 长期刷新令牌哈希。 */
  private refreshTokens = new Map<string, Map<string, number>>();

  constructor(
    private readonly dataFile: string,
    /** 令牌签名密钥。必须在启动时校验,不允许用默认值跑生产。 */
    private readonly tokenSecret: string,
  ) {
    if (!tokenSecret) throw new Error('缺少令牌签名密钥 AEGIS_TOKEN_SECRET');
    this.load();
  }

  private load() {
    if (!existsSync(this.dataFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.dataFile, 'utf8')) as {
        users: StoredCredential[];
        refreshTokens: Record<string, Record<string, number>>;
      };
      for (const user of raw.users ?? []) this.users.set(user.userId, user);
      for (const [userId, tokens] of Object.entries(raw.refreshTokens ?? {})) {
        this.refreshTokens.set(userId, new Map(Object.entries(tokens)));
      }
    } catch {
      // 凭据文件损坏时不静默重置为空——那会让所有用户突然"不存在",
      // 表现为无法登录且无从排查。宁可启动失败。
      throw new Error(`凭据文件损坏,拒绝启动: ${this.dataFile}`);
    }
  }

  private persist() {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const payload = {
      users: [...this.users.values()],
      refreshTokens: Object.fromEntries(
        [...this.refreshTokens.entries()].map(([k, v]) => [k, Object.fromEntries(v)]),
      ),
    };
    writeFileSync(this.dataFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
  }

  /**
   * 注册。userId 由调用方提供(小程序传 openid,Web 端传用户名)。
   * 已存在则返回 null,由上层提示"该账户已存在,请直接登录"。
   */
  register(userId: string, password: string): string | null {
    const id = userId.trim();
    if (!id || id.length > 128) throw new Error('账户标识不合法');
    if (password.length < 8) throw new Error('登录密码至少 8 位');
    if (this.users.has(id)) return null;

    const salt = randomBytes(16);
    const user: StoredCredential = {
      userId: id,
      salt: salt.toString('hex'),
      hash: hashPassword(password, salt).toString('hex'),
      createdAt: Date.now(),
    };
    this.users.set(id, user);
    this.persist();
    return id;
  }

  /**
   * 校验登录口令。
   * 用户不存在时也执行一次哈希运算,让响应时间与用户存在时接近,
   * 避免通过时间差枚举出哪些账户已注册。
   */
  verify(userId: string, password: string): boolean {
    const user = this.users.get(userId.trim());
    if (!user) {
      hashPassword(password, randomBytes(16));
      return false;
    }
    const candidate = hashPassword(password, Buffer.from(user.salt, 'hex'));
    const expected = Buffer.from(user.hash, 'hex');
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  }

  exists(userId: string): boolean {
    return this.users.has(userId.trim());
  }

  // ---- 令牌 ----

  /**
   * 签发访问令牌。
   * 用 HMAC 而非 JWT:服务端本来就持有密钥库,
   * 无状态 JWT 的收益(可分发验证)在这里没有价值,
   * 而有状态令牌支持即时吊销——用户丢失设备时能立刻失效。
   */
  issueAccessToken(userId: string, deviceId: string, secret: string, ttlSeconds = 3600): string {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const payload = `${userId}|${deviceId}|${expiresAt}`;
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    return `${Buffer.from(payload).toString('base64url')}.${sig}`;
  }

  verifyAccessToken(token: string, secret: string): { userId: string; deviceId: string } | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const payloadB64 = parts[0];
    const sig = parts[1];
    if (!payloadB64 || !sig) return null;

    const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    if (sig.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

    const segments = payload.split('|');
    const userId = segments[0];
    const deviceId = segments[1] ?? 'unknown';
    const expiresAt = Number(segments[2]);
    if (!userId) return null;
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
    if (!this.users.has(userId)) return null;
    return { userId, deviceId };
  }

  issueRefreshToken(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    const hash = this.hashToken(token);
    if (!this.refreshTokens.has(userId)) this.refreshTokens.set(userId, new Map());
    this.refreshTokens.get(userId)!.set(hash, Date.now());
    this.pruneRefreshTokens();
    this.persist();
    return token;
  }

  /**
   * 用刷新令牌换新的访问令牌。
   * 刷新令牌一次性使用:换取成功后立即作废。
   * 若同一个令牌被用第二次,说明可能已泄露,此时吊销该用户的全部刷新令牌。
   */
  refresh(userId: string, refreshToken: string): { accessToken: string; refreshToken: string } | null {
    const tokens = this.refreshTokens.get(userId);
    if (!tokens) return null;
    const hash = this.hashToken(refreshToken);

    if (!tokens.has(hash)) {
      // 令牌不存在或已被使用过。若曾被使用,视为泄露。
      const used = this.usedRefreshTokens.get(`${userId}|${hash}`);
      if (used) {
        tokens.clear();
        this.persist();
      }
      return null;
    }

    tokens.delete(hash);
    this.usedRefreshTokens.set(`${userId}|${hash}`, Date.now());
    this.pruneUsedTokens();
    this.persist();

    return {
      accessToken: this.issueAccessToken(userId, 'refreshed', this.tokenSecret),
      refreshToken: this.issueRefreshToken(userId),
    };
  }

  private usedRefreshTokens = new Map<string, number>();

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private pruneRefreshTokens() {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const tokens of this.refreshTokens.values()) {
      for (const [hash, at] of tokens) if (at < cutoff) tokens.delete(hash);
    }
  }

  private pruneUsedTokens() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [key, at] of this.usedRefreshTokens) {
      if (at < cutoff) this.usedRefreshTokens.delete(key);
    }
  }

  /** 登出:吊销该用户全部刷新令牌。 */
  logout(userId: string) {
    this.refreshTokens.delete(userId);
    this.persist();
  }
}
