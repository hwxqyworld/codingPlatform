/**
 * 把 Monaco 编辑器的本地构建(min/vs, 含 worker)复制到 public/monaco/vs。
 * 前端通过 loader.config({ paths: { vs: '/monaco/vs' } }) 在运行时加载,
 * 全部走本地产物, 不依赖 CDN, 离线可用; 也避免把 Monaco 打进 webpack 主包
 * (体积大且某些 Node 版本下编译会触发 V8 cppgc 崩溃)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = path.join(__dirname, '..', 'public', 'monaco', 'vs');

if (!fs.existsSync(src)) {
  console.error('[copy-monaco] 未找到 monaco-editor/min/vs, 请先 npm install');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-monaco] 已复制 ${src} -> ${dest}`);
