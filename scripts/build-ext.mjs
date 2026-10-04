/**
 * 构建 MV3 扩展到 apps/extension/dist。
 *
 * dist 目录即是完整的"解压扩展"目录,可直接拖进 chrome://extensions。
 * 不做单文件打包:MV3 的 service worker 与内容脚本都支持 ESM,
 * 多文件反而更便于排查问题,也不需要引入 zip 步骤。
 */
import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'apps/extension/src');
const distDir = resolve(root, 'apps/extension/dist');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const shared = {
  bundle: true,
  format: 'esm',
  // service worker 用 type: module,内容脚本也是 ESM
  target: ['chrome116'],
  platform: 'browser',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  // 指向 core 源码而非 dist,避免改了 core 忘重跑 build:core
  alias: { '@twofa/core': resolve(root, 'packages/core/src/index.ts') },
  define: { 'process.env.NODE_ENV': '"production"' },
};

await build({ ...shared, entryPoints: [resolve(srcDir, 'background.ts')], outfile: resolve(distDir, 'background.js') });
await build({ ...shared, entryPoints: [resolve(srcDir, 'content.ts')], outfile: resolve(distDir, 'content.js') });
await build({ ...shared, entryPoints: [resolve(srcDir, 'popup.ts')], outfile: resolve(distDir, 'popup.js') });

// 静态资源原样拷贝
const statics = ['manifest.json', 'popup.html', 'popup.css'];
for (const name of statics) {
  await copyFile(resolve(srcDir, name), resolve(distDir, name));
}

// 体积报告:扩展商店对包体有上限,超了要先知道
console.log('扩展构建完成 ->', distDir);
for (const name of await readdir(distDir)) {
  const { size } = await stat(resolve(distDir, name));
  if (size > 1024) console.log(`  ${name} ${(size / 1024).toFixed(1)} KB`);
}
const manifest = JSON.parse(await readFile(resolve(distDir, 'manifest.json'), 'utf8'));
console.log(`安装:chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序 -> ${distDir}`);
console.log(`清单校验: ${manifest.name} v${manifest.version} (manifest v${manifest.manifest_version})`);
