import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildEmccArgs, createCompiler, loadCompileConfig } from '../src/compile.js';

/**
 * 编译服务测试:
 *   1. emcc 参数生成(纯函数, 无需工具链)
 *   2. compile.json 解析与源文件扫描
 *   3. 工具链缺失时的优雅降级
 *   4. 真实构建全链路(仅在检测到 emcc 时运行, 否则跳过)
 */

// ---------------- 1. 参数生成 ----------------

test('buildEmccArgs: 默认 SDL2 构建参数', () => {
  const args = buildEmccArgs({
    sources: ['main.cpp'],
    libraries: ['SDL2'],
    flags: ['-O2', '-sALLOW_MEMORY_GROWTH=1'],
    preload: [],
    outBase: 'C:/out/index',
    shellFile: 'shell.html',
  });
  assert.ok(args.includes('-sUSE_SDL=2'), '应启用 SDL2 端口');
  assert.ok(args.includes('-O2'));
  assert.ok(args.includes('-sALLOW_MEMORY_GROWTH=1'));
  assert.ok(args.includes('main.cpp'));
  assert.deepEqual(args.slice(-4), ['-o', 'C:/out/index', '--shell-file', 'shell.html']);
});

test('buildEmccArgs: 多库映射(SDL2_image / SDL2_ttf / SDL1)', () => {
  const args = buildEmccArgs({
    sources: ['main.cpp'],
    libraries: ['SDL', 'SDL2_image', 'SDL2_ttf', 'SDL2_mixer'],
    flags: [],
    preload: ['assets'],
    outBase: 'out/index',
  });
  assert.ok(args.includes('-sUSE_SDL=1'));
  assert.ok(args.includes('-sUSE_SDL_IMAGE=2'));
  assert.ok(args.includes('-sUSE_SDL_TTF=2'));
  assert.ok(args.includes('-sUSE_SDL_MIXER=2'));
  assert.ok(args.includes('--preload-file'));
  assert.ok(args.includes('assets'));
});

// ---------------- 2. 配置解析 ----------------

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cppp-cfg-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

test('loadCompileConfig: 无 compile.json 时自动扫描根目录与 src/', () => {
  const dir = makeRepo({
    'main.cpp': 'x',
    'src/game.cpp': 'x',
    'src/game.h': 'x',          // 头文件不应被当作源文件
    'data.txt': 'x',            // 非 C/C++ 不应被扫描
    'build/ignored.cpp': 'x',   // 忽略目录
  });
  const cfg = loadCompileConfig(dir);
  assert.deepEqual(cfg.sources, ['main.cpp', 'src/game.cpp']);
  assert.deepEqual(cfg.libraries, ['SDL2'], '默认启用 SDL2');
  assert.deepEqual(cfg.flags, ['-O2', '-sALLOW_MEMORY_GROWTH=1']);
  assert.deepEqual(cfg.preload, [], '无 assets 目录时不预加载');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadCompileConfig: assets 目录自动预加载', () => {
  const dir = makeRepo({ 'main.cpp': 'x', 'assets/icon.png': 'x' });
  const cfg = loadCompileConfig(dir);
  assert.deepEqual(cfg.preload, ['assets']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadCompileConfig: compile.json 覆盖默认值 + 通配符展开', () => {
  const dir = makeRepo({
    'compile.json': JSON.stringify({
      sources: ['src/*.cpp', 'extra.cpp'],
      libraries: ['SDL2', 'SDL2_image'],
      flags: ['-O0'],
      preload: ['assets'],
    }),
    'src/a.cpp': 'x',
    'src/b.cpp': 'x',
    'src/a.h': 'x',
    'extra.cpp': 'x',
    'assets/x.png': 'x',
  });
  const cfg = loadCompileConfig(dir);
  assert.deepEqual(cfg.sources, ['extra.cpp', 'src/a.cpp', 'src/b.cpp']);
  assert.deepEqual(cfg.libraries, ['SDL2', 'SDL2_image']);
  assert.deepEqual(cfg.flags, ['-O0']);
  assert.deepEqual(cfg.preload, ['assets']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadCompileConfig: 没有源文件时报错; 非法 JSON 报错', () => {
  const empty = makeRepo({ 'readme.txt': 'hi' });
  assert.throws(() => loadCompileConfig(empty), /未找到任何 C\/C\+\+/);
  fs.rmSync(empty, { recursive: true, force: true });

  const bad = makeRepo({ 'compile.json': '{broken', 'main.cpp': 'x' });
  assert.throws(() => loadCompileConfig(bad), /compile\.json 解析失败/);
  fs.rmSync(bad, { recursive: true, force: true });
});

// ---------------- 3. 工具链探测与降级 ----------------

let compiler;
let tmpArtifacts;

before(() => {
  tmpArtifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'cppp-art-'));
  // 覆盖候选列表, 确保“工具链缺失”场景在本机已安装 emsdk 时也能稳定复现
  compiler = createCompiler({
    emcc: 'emcc-definitely-not-installed',
    emccCandidates: ['emcc-definitely-not-installed'],
    buildTimeoutMs: 5000,
    artifactsDir: tmpArtifacts,
    shellFile: path.join(os.tmpdir(), 'shell.html'),
  });
});

after(() => {
  fs.rmSync(tmpArtifacts, { recursive: true, force: true, maxRetries: 3 });
});

test('工具链缺失: findEmcc 优雅返回不可用(不抛异常)', async () => {
  const info = await compiler.findEmcc();
  assert.equal(info.ok, false);
});

test('工具链缺失: compileDir 返回失败日志与安装指引', async () => {
  const dir = makeRepo({ 'main.cpp': 'int main(){return 0;}' });
  const result = await compiler.compileDir('w-test', dir);
  assert.equal(result.ok, false);
  assert.match(result.log, /emcc/);
  assert.match(result.log, /emsdk/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------- 4. 真实构建全链路(有 emcc 才运行) ----------------

test('真实构建: emcc 可用时完整跑通(否则跳过)', async (t) => {
  // 此处用生产默认探测逻辑(而非上面受限的候选列表), 验证自动发现真实工具链
  const prodCompiler = createCompiler({
    emcc: 'emcc',
    buildTimeoutMs: 5 * 60 * 1000,
    artifactsDir: tmpArtifacts,
    shellFile: path.join(os.tmpdir(), 'shell.html'),
  });
  const emcc = await prodCompiler.findEmcc();
  if (!emcc.ok) {
    t.skip('未检测到 emcc 工具链, 跳过真实构建测试(可运行 scripts/install-emscripten.bat 或参考 README 安装)');
    return;
  }

  // 通过完整 API 链路验证: 创建 -> 换成最小 C 程序 -> 发布 -> 构建成功 -> 产物就位
  const { login, poll, startServer } = await import('./helpers.js');
  const srv = await startServer();
  try {
    await login(srv, '构建测试员');
    const created = await srv.api('/api/works', { method: 'POST', body: { title: '真实构建' } });
    const id = created.work.id;
    await srv.api(`/api/works/${id}/file`, {
      method: 'PUT',
      body: { path: 'main.cpp', content: '// 临时替换为最小程序\n' },
    });
    await srv.api(`/api/works/${id}/file`, {
      method: 'PUT',
      body: {
        path: 'compile.json',
        content: JSON.stringify({ sources: ['main.cpp'], libraries: [], flags: ['-O0'] }),
      },
    });
    await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: '最小程序' } });
    await srv.api(`/api/works/${id}/publish`, { method: 'POST' });

    const work = await poll(async () => {
      const d = await srv.api(`/api/works/${id}`);
      return d.work.buildStatus !== 'building' ? d.work : null;
    }, { timeout: 5 * 60 * 1000, desc: '真实构建结束' });

    assert.equal(work.buildStatus, 'success', `构建应成功, 日志: ${work.buildLog}`);
    const dir = path.join(srv.dataDir, 'artifacts', id, 'current');
    for (const f of ['index.html', 'index.js', 'index.wasm']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `产物 ${f} 应存在`);
    }
    // 运行产物可通过 /w/ 访问
    const res = await fetch(`${srv.base}/w/${id}/`);
    assert.equal(res.status, 200);
  } finally {
    await srv.close();
  }
});
