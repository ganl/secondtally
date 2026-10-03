/**
 * 服务端入口。
 *
 * 启动即校验配置:缺失或使用弱默认值时直接退出,
 * 而不是带着不安全的配置跑起来——这类"静默降级"在生产上代价极高。
 */

import { resolve } from 'node:path';
import { AegiServer, createLogger } from './server.js';

const logger = createLogger();

function required(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    logger.error(`缺少必需的环境变量 ${name}`);
    process.exit(1);
  }
  return value.trim();
}

const isProduction = process.env.NODE_ENV === 'production';

// 令牌密钥在生产必须是显式提供的随机值。
// 开发环境允许回退到固定值,但会打醒目警告,避免误带到生产。
let tokenSecret = process.env.AEGIS_TOKEN_SECRET?.trim();
if (!tokenSecret) {
  if (isProduction) {
    logger.error('生产环境必须设置 AEGIS_TOKEN_SECRET,生成方式: openssl rand -hex 32');
    process.exit(1);
  }
  tokenSecret = 'dev-only-insecure-secret-do-not-use-in-production';
  logger.warn('AEGIS_TOKEN_SECRET 未设置,正在使用开发默认值。仅限本地开发。');
}

if (isProduction && tokenSecret.length < 32) {
  logger.error('生产环境的 AEGIS_TOKEN_SECRET 至少需要 32 个字符');
  process.exit(1);
}

const allowedOrigins = (process.env.AEGIS_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (isProduction && allowedOrigins.includes('*')) {
  logger.error('生产环境不允许 CORS 通配符 *,请配置具体来源');
  process.exit(1);
}

const config = {
  port: Number.parseInt(process.env.PORT ?? '8787', 10),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: resolve(process.env.AEGIS_DATA_DIR ?? './server/data'),
  tokenSecret,
  allowedOrigins,
  accessTokenTtl: Number.parseInt(process.env.AEGIS_TOKEN_TTL ?? '3600', 10),
  isProduction,
};

if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
  logger.error('PORT 必须是 1-65535 之间的数字');
  process.exit(1);
}

const server = new AegiServer(config, logger);
await server.listen();

// 优雅停机:先停止接收新连接,再退出。
// 粗暴 exit(1) 会在同步写入中途断开,可能导致用户误以为同步失败而重复操作。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info(`收到 ${signal},开始优雅停机`);
    server
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error('停机失败', { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      });
  });
}
