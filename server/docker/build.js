#!/usr/bin/env node
/**
 * 容器内构建脚本 —— 由构建容器池的任务驱动执行:
 *   node /opt/platform/build.js <repoDir> <srcDir> <outDir>
 *
 * 职责(与宿主机 compile.js 语义保持一致):
 *   1. 用 git 从裸仓库副本导出 main 分支快照(容器内执行 git 处理)
 *   2. 解析仓库根目录 compile.json, 生成 emcc 编译参数
 *   3. 执行 emcc 编译(超时由 BUILD_TIMEOUT_MS 环境变量控制)
 *   4. 校验产物并写入 <outDir>/status.json { ok, log }
 *
 * 运行环境: 容器内非特权用户, 无网络(所有依赖已在镜像构建期预下载)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [repoDir, srcDir, outDir] = process.argv.slice(2);
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 60000);
const started = Date.now();

// ---------------- git 快照导出(容器内执行) ----------------

function git(args, extraEnv = {}) {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} 失败: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout.trim();
}

function exportMain() {
  fs.mkdirSync(srcDir, { recursive: true });
  // 临时索引放在 srcDir 之外(checkout-index 在 work-tree 内会失效);
  // read-tree 与 checkout-index 必须共用同一个索引
  const indexFile = path.join(os.tmpdir(), `git-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    git(['--git-dir=' + repoDir, 'read-tree', 'main'], env);
    git(['--git-dir=' + repoDir, '--work-tree=' + srcDir, 'checkout-index', '-a', '-f'], env);
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

// ---------------- 编译配置(与宿主机 compile.js 一致) ----------------

const LIBRARY_FLAGS = {
  SDL: ['-sUSE_SDL=1'],
  SDL2: ['-sUSE_SDL=2'],
  SDL2_image: ['-sUSE_SDL_IMAGE=2', '-sSDL2_IMAGE_FORMATS=png,jpg,bmp,gif'],
  SDL2_ttf: ['-sUSE_SDL_TTF=2'],
  SDL2_mixer: ['-sUSE_SDL_MIXER=2'],
};
const DEFAULT_LIBRARIES = ['SDL2'];
const DEFAULT_FLAGS = ['-O2', '-sALLOW_MEMORY_GROWTH=1'];
const SOURCE_EXT = /\.(c|cpp|cc|cxx)$/i;
const SKIP_DIRS = new Set(['.git', 'artifacts', 'build', 'dist', 'node_modules', 'out']);

function scanDir(dir, base) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
      out.push(...scanDir(path.join(dir, ent.name), base ? `${base}/${ent.name}` : ent.name));
    } else if (SOURCE_EXT.test(ent.name)) {
      out.push(base ? `${base}/${ent.name}` : ent.name);
    }
  }
  return out;
}

function expandSources(buildDir, patterns) {
  const out = new Set();
  for (const p of patterns) {
    const abs = path.join(buildDir, p);
    if (p.includes('*')) {
      const dir = path.dirname(abs);
      const re = new RegExp(
        '^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      );
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (re.test(f) && SOURCE_EXT.test(f)) out.add(path.posix.join(path.dirname(p), f));
        }
      }
    } else if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      out.add(...scanDir(abs, p.replace(/[\\/]+$/, '')));
    } else {
      out.add(p);
    }
  }
  return [...out].sort();
}

function loadCompileConfig(buildDir) {
  const cfgFile = path.join(buildDir, 'compile.json');
  let raw = {};
  if (fs.existsSync(cfgFile)) {
    raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  }
  let sources;
  if (raw.sources?.length) {
    sources = expandSources(buildDir, raw.sources);
  } else {
    sources = scanDir(buildDir, '');
  }
  if (!sources.length) throw new Error('未找到任何 C/C++ 源文件(.c/.cpp/.cc/.cxx)');
  const libraries = raw.libraries?.length ? raw.libraries : DEFAULT_LIBRARIES;
  const flags = raw.flags?.length ? raw.flags : DEFAULT_FLAGS;
  let preload = raw.preload || [];
  if (!preload.length && fs.existsSync(path.join(buildDir, 'assets'))) preload = ['assets'];
  return { sources, libraries, flags, preload };
}

function buildEmccArgs({ sources, libraries, flags, preload, outBase, shellFile }) {
  const args = [];
  for (const f of flags || []) args.push(f);
  for (const lib of libraries || []) args.push(...(LIBRARY_FLAGS[lib] || [`-l${lib}`]));
  for (const p of preload || []) args.push('--preload-file', p);
  for (const s of sources || []) args.push(s);
  args.push('-o', outBase);
  if (shellFile) args.push('--shell-file', shellFile);
  return args;
}

// ---------------- 执行 ----------------

function writeStatus(status) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'status.json'), JSON.stringify(status));
}

try {
  exportMain();
  const buildCfg = loadCompileConfig(srcDir);
  const args = buildEmccArgs({
    ...buildCfg,
    outBase: path.join(outDir, 'index.html'), // -> index.html / index.js / index.wasm
    shellFile: '/opt/platform/shell.html',
  });

  const r = spawnSync('emcc', args, {
    cwd: srcDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: BUILD_TIMEOUT_MS,
    env: process.env,
  });
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (r.error && r.error.killed) {
    writeStatus({ ok: false, log: `构建超时(超过 ${Math.round(BUILD_TIMEOUT_MS / 1000)} 秒)\n${output}` });
    process.exit(0);
  }
  if (r.status !== 0) {
    writeStatus({ ok: false, log: `构建失败(用时 ${elapsed}s)\n${output || 'emcc 退出码非零'}` });
    process.exit(0);
  }

  const log = `构建完成(用时 ${elapsed}s, 容器内 Emscripten)\n${output}`;
  const files = fs.readdirSync(outDir);
  if (!files.includes('index.html') || !files.includes('index.js')) {
    writeStatus({
      ok: false,
      log: `${log}\n缺少产物 index.html / index.js, 实际产物: ${files.join(', ')}`,
    });
    process.exit(0);
  }
  writeStatus({ ok: true, log });
  process.exit(0);
} catch (err) {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  writeStatus({ ok: false, log: `构建失败(用时 ${elapsed}s)\n${err?.message || err}` });
  process.exit(0);
}
