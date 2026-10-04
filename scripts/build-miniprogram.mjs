/**
 * 构建小程序产物。
 *
 * 做法:把 core 打成单文件 ESM,拷进小程序的 utils 目录。
 * 小程序不支持直接引入 node_modules,传统做法是配置 miniprogram_npm,
 * 但那套流程需要开发者工具参与、配置易错。单文件方案在 CI 里更可靠。
 */
import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const miniDir = resolve(root, 'apps/miniprogram');
const utilsDir = resolve(miniDir, 'utils');

await mkdir(utilsDir, { recursive: true });

// 1. 打包 core(小程序目标:es2017,压缩,不含 node 内置模块)
await build({
  entryPoints: [resolve(root, 'packages/core/src/index.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2017'],
  platform: 'browser',
  outfile: resolve(utilsDir, 'core.mjs'),
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

// 2. 打包 platform.ts(它 import 了 @twofa/core,需要把 core 一起打进去)
await build({
  entryPoints: [resolve(miniDir, 'platform.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2017'],
  platform: 'browser',
  outfile: resolve(utilsDir, 'platform.mjs'),
  minify: true,
  logLevel: 'info',
});

// 3. 写一个转发模块,页面用 require 风格引用时不必关心打包细节
const shim = `// 自动生成,请勿手改。核心库由 scripts/build-miniprogram.mjs 产出。
export * from './core.mjs';
`;
await writeFile(resolve(utilsDir, 'index.mjs'), shim, 'utf8');

// 4. 生成 core.mjs 的类型声明。
//
// core.mjs 是构建产物,本身没有类型。若不做处理,tsc 只能看到它的运行时导出,
// 于是 import { VaultService } 会被判成"引入了值而非类型"。
//
// 这里让声明文件重新导回 TypeScript 源码:运行时用压缩过的单文件,
// 类型检查用原始源码,两者同源于 packages/core,不会失配。
// 不要手写转发声明——core 改了就一定会漏。
//
// 关键:必须用 `export * from` 而非 re-export 列表。列表写法在
// declaration file 里对 re-export 的类型不生效,表现为"has no exported member"。
// 用 .d.ts 而非 .d.mts:配对的 .mjs 会被 tsc 当作 JS 优先解析,
// .d.mts 声明被忽略。
await writeFile(
  resolve(utilsDir, 'core.d.ts'),
  `// 自动生成,请勿手改。类型重新指向源码,运行时仍用压缩后的 core.mjs。
export * from '../../packages/core/src/index.js';
`,
  'utf8',
);

// platform.mjs 同理:运行时是 bundle,类型回指 platform.ts。
// platform.ts 本身 import type from '@twofa/core',故依赖 workspace 链接。
// 用 .d.ts 而非 .d.mts:配对的 .mjs 会被 tsc 当作 JS 优先解析,
// .d.mts 声明被忽略,报出"has no exported member"。
await writeFile(
  resolve(utilsDir, 'platform.d.ts'),
  `// 自动生成,请勿手改。类型重新指向源码,运行时仍用 bundle 后的 platform.mjs。
export * from '../platform.js';
`,
  'utf8',
);

const size = (await readFile(resolve(utilsDir, 'core.mjs'), 'utf8')).length;
console.log(`小程序依赖就绪:utils/core.mjs (${(size / 1024).toFixed(1)} KB)`);
console.log('提示:在微信开发者工具中导入 apps/miniprogram 目录即可运行。');
