/**
 * 构建 core 为单文件 ESM。
 *
 * 为什么要打包成单文件而不是让各端直接引 TS 源码:
 * 微信小程序的npm 构建流程(miniprogram_npm)配置繁琐且极易出错,
 * 直接产出一个自包含的 ESM 文件,小程序与浏览器都能直接引入。
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'packages/core/dist');

await mkdir(outdir, { recursive: true });

const shared = {
  entryPoints: [resolve(root, 'packages/core/src/index.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  // 用 browser 而非 neutral:noble 的 hash 函数在 neutral 模式下会被
  // 误判为全局变量而丢失函数引用(表现为运行时 SHA1 is not defined)
  platform: 'browser',
  // 主包:给 Node / 测试 / 浏览器
  outfile: resolve(outdir, 'index.mjs'),
  sourcemap: true,
  logLevel: 'info',
};

// Node 端:保留 node: 前缀解析
await build({ ...shared });

// 小程序端:降到 ES2017 并压缩,小程序 JSCore 对新语法支持有限
await build({
  ...shared,
  outfile: resolve(outdir, 'index.mini.mjs'),
  target: ['es2017'],
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

console.log('core 构建完成 ->', outdir);
