import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './errors.js';

const execFileP = promisify(execFile);

/**
 * 编译服务 —— 使用 Emscripten(emcc) 将 C/C++ 作品编译为 WebAssembly + SDL。
 *
 * 约定:
 *   - 仓库根目录的 compile.json 可选, 描述构建方式:
 *       {
 *         "sources":   ["main.cpp", "src/*.cpp"],   // 缺省: 自动扫描 .c/.cpp/.cc/.cxx
 *         "libraries": ["SDL2", "SDL2_image"],       // 缺省: ["SDL2"]
 *         "flags":     ["-O2", "-sALLOW_MEMORY_GROWTH=1"],  // 缺省同上
 *         "preload":   ["assets"]                    // 缺省: 存在 assets 目录时自动预加载
 *       }
 *   - 产物固定命名为 index.html / index.js / index.wasm(可含 index.data 预加载文件),
 *     安装到 artifacts/<workId>/current 供 /w/<workId>/ 静态托管。
 *   - 工具链缺失时优雅降级: 返回构建失败日志 + 安装指引, 不影响发布流程本身。
 */

// SDL 库名 -> emcc 端口参数 映射
const LIBRARY_FLAGS = {
  SDL:        ['-sUSE_SDL=1'],
  SDL2:       ['-sUSE_SDL=2'],
  SDL2_image: ['-sUSE_SDL_IMAGE=2', '-sSDL2_IMAGE_FORMATS=png,jpg,bmp,gif'],
  SDL2_ttf:   ['-sUSE_SDL_TTF=2'],
  SDL2_mixer: ['-sUSE_SDL_MIXER=2'],
};

const DEFAULT_LIBRARIES = ['SDL2'];
const DEFAULT_FLAGS = ['-O2', '-sALLOW_MEMORY_GROWTH=1'];
const SOURCE_EXT = /\.(c|cpp|cc|cxx)$/i;
const SKIP_DIRS = new Set(['.git', 'artifacts', 'build', 'dist', 'node_modules', 'out']);

/**
 * 由构建配置计算 emcc 参数(纯函数, 便于单测)。
 * 顺序: 编译选项 -> 库端口 -> 预加载 -> 源文件 -> 输出 -> 外壳。
 */
export function buildEmccArgs({ sources, libraries, flags, preload, outBase, shellFile }) {
  const args = [];
  for (const f of flags || []) args.push(f);
  for (const lib of libraries || []) {
    args.push(...(LIBRARY_FLAGS[lib] || [`-l${lib}`])); // 未收录的库名按系统库处理
  }
  for (const p of preload || []) args.push('--preload-file', p);
  for (const s of sources || []) args.push(s);
  args.push('-o', outBase);
  if (shellFile) args.push('--shell-file', shellFile);
  return args;
}

/** 递归扫描目录下的 C/C++ 源文件, 返回相对路径列表 */
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

/** 展开 compile.json 中的 sources(支持精确路径 / 目录 / *.cpp 通配) */
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

/**
 * 读取并规范化构建配置(compile.json 可选)。
 * 返回 { sources, libraries, flags, preload }。
 */
export function loadCompileConfig(buildDir) {
  const cfgFile = path.join(buildDir, 'compile.json');
  let raw = {};
  if (fs.existsSync(cfgFile)) {
    try {
      raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch (e) {
      throw new AppError(`compile.json 解析失败: ${e.message}`);
    }
  }

  let sources;
  if (raw.sources?.length) {
    sources = expandSources(buildDir, raw.sources);
  } else {
    sources = scanDir(buildDir, ''); // 缺省: 扫描整个仓库
  }
  if (!sources.length) throw new AppError('未找到任何 C/C++ 源文件(.c/.cpp/.cc/.cxx)');

  const libraries = raw.libraries?.length ? raw.libraries : DEFAULT_LIBRARIES;
  const flags = raw.flags?.length ? raw.flags : DEFAULT_FLAGS;
  let preload = raw.preload || [];
  if (!preload.length && fs.existsSync(path.join(buildDir, 'assets'))) preload = ['assets'];

  return { sources, libraries, flags, preload };
}

/**
 * 编译器工厂。
 */
export function createCompiler(cfg) {
  /**
   * emcc 候选位置(跨平台, 不写死 .bat/.exe 后缀, Windows/Linux/macOS 通用):
   *   1) 环境变量 EMCC 显式指定(最高优先级)
   *   2) 环境变量 EMSDK -> $EMSDK/upstream/emscripten/emcc
   *   3) PATH 上的 emcc(由操作系统按 PATHEXT 解析 emcc.exe / emcc.bat)
   *   4) 常见 emsdk 安装位置兜底(~/emsdk, /opt/emsdk, /usr/local/emsdk, 盘符根目录)
   * cfg.emccCandidates 可覆盖整个候选列表(内部/测试用)。
   */
  const emccCandidates = cfg.emccCandidates || (() => {
    const list = [];
    if (cfg.emcc && cfg.emcc !== 'emcc') list.push(cfg.emcc);
    if (process.env.EMSDK) list.push(path.join(process.env.EMSDK, 'upstream', 'emscripten', 'emcc'));
    list.push('emcc');
    list.push(path.join(os.homedir(), 'emsdk', 'upstream', 'emscripten', 'emcc'));
    list.push('/opt/emsdk/upstream/emscripten/emcc');
    list.push('/usr/local/emsdk/upstream/emscripten/emcc');
    list.push('C:/emsdk/upstream/emscripten/emcc');
    list.push('D:/emsdk/upstream/emscripten/emcc');
    list.push('E:/emsdk/upstream/emscripten/emcc');
    return [...new Set(list)];
  })();

  let emccCache = null; // 探测结果缓存

  /**
   * 把候选解析为真实可执行文件:
   *   - Windows: 无后缀路径自动补 .exe/.bat/.cmd(emsdk 内 emcc 实际是 emcc.exe)
   *   - 其他平台: 原样返回(emcc 是无后缀的 python 脚本, 由 shebang 执行)
   */
  function resolveCandidate(cand) {
    if (cand === 'emcc' || fs.existsSync(cand)) return cand;
    if (process.platform === 'win32') {
      for (const ext of ['.exe', '.bat', '.cmd']) {
        if (fs.existsSync(cand + ext)) return cand + ext;
      }
    }
    return cand;
  }

  /** 执行 emcc(.bat/.cmd 在 Windows 上必须经 cmd 启动; Linux/macOS 直接执行) */
  function runEmcc(emccPath, args, opts) {
    if (/\.(bat|cmd)$/i.test(emccPath)) {
      return execFileP(process.env.ComSpec || 'cmd.exe', ['/c', emccPath, ...args], opts);
    }
    return execFileP(emccPath, args, opts);
  }

  /** 探测某个候选是否可用 */
  async function probe(cand) {
    const emccPath = resolveCandidate(cand);
    try {
      const { stdout } = await runEmcc(emccPath, ['--version'], {
        timeout: 20000,
        windowsHide: true,
      });
      // 兼容新旧格式: 3.x 为 "clang-like) 3.1.x", 6.x 为 "clang-like replacement + linker ... ld) 6.0.6"
      const m = stdout.match(/emcc \(Emscripten gcc\/clang-like[^)]*\)\s+([\d.]+)/);
      return { ok: true, version: m ? m[1] : '未知版本', path: emccPath };
    } catch {
      return { ok: false, version: null };
    }
  }

  /** 探测工具链(结果缓存) */
  async function findEmcc() {
    if (emccCache) return emccCache;
    for (const cand of emccCandidates) {
      const info = await probe(cand);
      if (info.ok) {
        emccCache = info;
        return emccCache;
      }
    }
    emccCache = { ok: false, version: null, path: emccCandidates[0] };
    return emccCache;
  }

  const TOOLCHAIN_HINT = [
    '未检测到 Emscripten 工具链(emcc), 无法构建 WebAssembly。',
    '安装方法(Windows / Linux / macOS 通用):',
    '  Windows:',
    '    运行 scripts\\install-emscripten.bat(自动克隆 emsdk 并安装 latest)',
    '  Linux / macOS:',
    '    git clone https://github.com/emscripten-core/emsdk.git ~/emsdk',
    '    cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest',
    '    source ./emsdk_env.sh  # 或直接让平台自动探测 ~/emsdk 下的 emcc',
    '平台自动探测顺序: EMCC 环境变量 -> EMSDK 环境变量 -> PATH 上的 emcc',
    '  -> 常见安装位置(~/emsdk, /opt/emsdk, /usr/local/emsdk)。',
    'EMCC / EMSDK 无需带 .bat/.exe 后缀, 跨平台通用。',
    '安装完成后重启平台服务即可自动检测。',
  ].join('\n');

  /**
   * 编译 srcDir 中的代码并把产物安装到 artifacts/<workId>/current。
   * @returns {Promise<{ok:boolean, log:string}>}
   */
  async function compileDir(workId, srcDir) {
    const emcc = await findEmcc();
    if (!emcc.ok) return { ok: false, log: TOOLCHAIN_HINT };

    const buildCfg = loadCompileConfig(srcDir);
    const outDir = path.join(path.dirname(srcDir), 'out');
    fs.mkdirSync(outDir, { recursive: true });

    const args = buildEmccArgs({
      ...buildCfg,
      // 必须带 .html 扩展名: 无扩展名时 emcc 不会生成 html/js 三件套
      outBase: path.join(outDir, 'index.html'), // -> index.html / index.js / index.wasm
      shellFile: cfg.shellFile,
    });

    const started = Date.now();
    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await runEmcc(emcc.path, args, {
        cwd: srcDir,
        timeout: cfg.buildTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }));
    } catch (err) {
      const log = [stdout, stderr, err.stderr || err.message].filter(Boolean).join('\n').trim();
      if (err.killed || err.signal === 'SIGTERM') {
        return { ok: false, log: `构建超时(超过 ${Math.round(cfg.buildTimeoutMs / 1000)} 秒)\n${log}` };
      }
      return { ok: false, log: log || '构建失败(未知错误)' };
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const log = `构建完成(用时 ${elapsed}s, emcc ${emcc.version})\n${[stdout, stderr].filter(Boolean).join('\n')}`.trim();
    const files = fs.readdirSync(outDir);
    if (!files.includes('index.html') || !files.includes('index.js')) {
      return { ok: false, log: `${log}\n缺少产物 index.html / index.js, 实际产物: ${files.join(', ')}` };
    }

    // 原子替换产物目录: 先复制到暂存目录, 再整体换名, 避免 /w/ 读到半成品
    const target = path.join(cfg.artifactsDir, workId, 'current');
    const staging = path.join(
      cfg.artifactsDir, workId,
      `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(outDir, staging, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    fs.renameSync(staging, target);
    return { ok: true, log };
  }

  return { findEmcc, compileDir, TOOLCHAIN_HINT };
}
