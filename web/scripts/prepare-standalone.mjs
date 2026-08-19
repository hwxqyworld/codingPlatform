/**
 * 准备 standalone 产物: Next 的 standalone 输出不含 .next/static 与 public/,
 * 需要手动复制(standalone 服务器启动后按相对目录提供这些静态资源)。
 * 在 postbuild 自动执行, 产物结构:
 *   .next/standalone/
 *     server.js
 *     .next/static/    <- 页面静态资源
 *     public/          <- favicon / manifest / monaco(min/vs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const standalone = path.join(root, '.next', 'standalone');

if (!fs.existsSync(standalone)) {
  console.error('[prepare-standalone] 未找到 .next/standalone, 请先 next build');
  process.exit(1);
}

// .next/static -> standalone/.next/static
fs.cpSync(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'), {
  recursive: true,
});
// public/ -> standalone/public
if (fs.existsSync(path.join(root, 'public'))) {
  fs.cpSync(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true });
}

console.log('[prepare-standalone] standalone 产物已就绪: .next/static + public 已复制');
