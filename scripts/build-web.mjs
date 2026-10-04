/**
 * 构建 Web 端产物到 apps/web/dist。
 *
 * 输出结构是刻意保持"可直接静态托管"的样子:
 *   dist/index.html
 *   dist/main.js
 *   dist/styles.css
 * 不引入 hash 化的资源名,是因为这个应用不依赖 CDN 与构建缓存指纹,
 * 部署时用 nginx 的 max-age 即可。
 */
import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = resolve(root, 'apps/web');
const distDir = resolve(webDir, 'dist');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

// 1. 打包应用。core 会被内联进 main.js,产物是单个自包含 JS。
await build({
  entryPoints: [resolve(webDir, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  platform: 'browser',
  outfile: resolve(distDir, 'main.js'),
  minify: true,
  sourcemap: true,
  logLevel: 'info',
  // 明确声明浏览器为唯一目标,让 noble 不会去找 node侧垫片
  define: { 'process.env.NODE_ENV': '"production"' },
  // 直接指向 core 源码而不是 dist:与小程序构建保持一致,
  // 避免改了 core 之后忘了重跑 build:core 而打出旧代码
  alias: { '@twofa/core': resolve(root, 'packages/core/src/index.ts') },
});

await copyFile(resolve(webDir, 'styles.css'), resolve(distDir, 'styles.css'));

// 2. 复制 index.html。源码里的引用已是 ./main.js 与 ./styles.css,
//    与产物文件名一致,原样复制即可。
//    路径保持相对(不带 /),这样部署到 https://host/2fa/ 这类子路径也能正常工作。
await copyFile(resolve(webDir, 'index.html'), resolve(distDir, 'index.html'));

// 3. 附一份最小部署说明,避免部署时漏掉安全响应头
const headers = `# 建议的 nginx 配置要点(服务端只存密文,但访问令牌仍需 HTTPS 保护)
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
# 页面不做 CDN 缓存:缓存住解锁后的界面没有意义,但会拖慢更新
add_header Cache-Control "no-store" always;
`;
await writeFile(resolve(distDir, '_headers.example'), headers, 'utf8');

const size = (await readFile(resolve(distDir, 'main.js'), 'utf8')).length;
console.log(`Web 构建完成 -> ${distDir}`);
console.log(`  main.js ${(size / 1024).toFixed(1)} KB`);
console.log('  用任意静态服务器托管即可,例如: npx serve apps/web/dist');
