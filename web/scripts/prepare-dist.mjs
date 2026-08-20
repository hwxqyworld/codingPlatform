/**
 * 生成 web/dist/ —— 站点根形态的静态资源目录(CDN 静态加速层用):
 *   dist/
 *     _next/static/    <- 页面 JS/CSS(与线上 /_next/static 路径一致)
 *     monaco/vs/       <- Monaco 编辑器(离线可用)
 *     favicon.svg / manifest.webmanifest / ...
 *
 * 注意: 这不包含可运行的页面 —— 页面仍由 Next.js standalone(SSR)渲染,
 * dist/ 仅用于把静态资源挂到 CDN/静态服务器加速。
 * 在 postbuild 自动执行, 依赖 next build 已产出 .next/static 与 public/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const staticDir = path.join(root, '.next', 'static');
const publicDir = path.join(root, 'public');
const dist = path.join(root, 'dist');

if (!fs.existsSync(staticDir)) {
  console.error('[prepare-dist] 未找到 .next/static, 请先 next build');
  process.exit(1);
}

// 清空并重建 dist/
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// .next/static -> dist/_next/static(保持线上 /_next/static 路径)
fs.cpSync(staticDir, path.join(dist, '_next', 'static'), { recursive: true });

// public/ 全部内容 -> dist/(favicon / manifest / monaco 等, 保持根路径)
if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, dist, { recursive: true });
}

console.log('[prepare-dist] 静态资源已就绪: web/dist/ (_next/static + public)');
