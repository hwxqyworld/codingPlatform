import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { login, poll, startServer } from './helpers.js';

const execFileP = promisify(execFile);

/**
 * API 集成测试: 覆盖创建作品 -> 编辑 -> 提交 -> 发布 -> 构建 -> 主页收录
 * 的完整链路, 以及权限、路径安全等边界情况。
 */
let srv;

before(async () => {
  srv = await startServer();
});

after(async () => {
  await srv.close();
});

test('健康检查', async () => {
  const d = await srv.api('/api/health');
  assert.equal(d.ok, true);
  assert.equal(d.name, 'cpp-platform');
});

test('账号注册/验证/登录与身份', async () => {
  const d = await login(srv, '张三');
  assert.ok(d.token, '应返回 token');
  // 重复登录返回同一 token(未修改密码前会话不轮换)
  const again = await srv.api('/api/auth/login', {
    method: 'POST',
    body: { account: '张三', password: 'test-pass-1234' },
  });
  assert.equal(again.token, d.token);
  // 邮箱登录同样可用
  const byEmail = await srv.api('/api/auth/login', {
    method: 'POST',
    body: { account: '张三@test.local', password: 'test-pass-1234' },
  });
  assert.equal(byEmail.token, d.token);
  // 身份信息
  const me = await srv.api('/api/me');
  assert.equal(me.creator, '张三');
  assert.equal(me.user.email, '张三@test.local');
  assert.equal(me.user.emailVerified, true);
  assert.deepEqual(me.works, []);
});

test('错误密码/未知账号登录被拒绝', async () => {
  await srv.api('/api/auth/login', {
    method: 'POST',
    body: { account: '张三', password: 'wrong-pass-123' },
    expect: 401,
  });
  await srv.api('/api/auth/login', {
    method: 'POST',
    body: { account: '不存在的人', password: 'test-pass-1234' },
    expect: 401,
  });
  await login(srv, '张三');
});

test('未登录访问受保护接口返回 401', async () => {
  srv.setToken('');
  await srv.api('/api/works', { method: 'POST', body: { title: 'x' }, expect: 401 });
  await login(srv, '张三');
});

test('创建作品: 自动初始化 git 仓库并写入模板', async () => {
  const d = await srv.api('/api/works', {
    method: 'POST',
    body: { title: '我的第一个游戏', description: 'SDL2 演示' },
  });
  const work = d.work;
  assert.ok(work.id.startsWith('w'));
  assert.equal(work.creator, '张三');
  assert.equal(work.buildStatus, 'none');
  assert.equal(work.publishedSha, null); // 尚未发布 = 草稿

  // 模板文件齐全
  const files = await srv.api(`/api/works/${work.id}/files`);
  const names = files.files.map((f) => f.path);
  for (const expect of ['main.cpp', 'compile.json', 'README.md']) {
    assert.ok(names.includes(expect), `应包含模板文件 ${expect}`);
  }

  // 默认作品双分支: develop(内部) + main(发布分支, 已初始化, 可直接推送)
  const branches = (await execFileP('git', ['-C', path.join(srv.dataDir, 'repos', `${work.id}.git`), 'branch'])).stdout;
  assert.match(branches, /\bdevelop\b/, '应存在 develop 分支');
  assert.match(branches, /\bmain\b/, '应存在 main 分支');

  return work;
});

test('路径穿越防护: 禁止读取工作区之外的文件', async () => {
  const created = await srv.api('/api/works', {
    method: 'POST',
    body: { title: '路径安全测试' },
  });
  const id = created.work.id;
  for (const evil of ['../../platform.db', '..\\..\\platform.db', '/etc/passwd', 'a/../../b']) {
    await srv.api(`/api/works/${id}/file?path=${encodeURIComponent(evil)}`, { expect: 400 });
  }
});

test('在线编辑: 保存文件 -> 提交 develop -> 记录历史', async () => {
  const created = await srv.api('/api/works', {
    method: 'POST',
    body: { title: '编辑测试' },
  });
  const id = created.work.id;

  // 保存文件(写入 develop 工作区)
  const code = '// 测试代码\n#include <SDL2/SDL.h>\nint main(){return 0;}\n';
  await srv.api(`/api/works/${id}/file`, { method: 'PUT', body: { path: 'main.cpp', content: code } });
  const read = await srv.api(`/api/works/${id}/file?path=main.cpp`);
  assert.equal(read.content, code);

  // 新建文件
  await srv.api(`/api/works/${id}/file`, { method: 'PUT', body: { path: 'src/util.cpp', content: 'int add(int a,int b){return a+b;}' } });
  const files = await srv.api(`/api/works/${id}/files`);
  assert.ok(files.files.some((f) => f.path === 'src/util.cpp'));

  // 提交到 develop
  const commit = await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: '完成编辑器开发' } });
  assert.ok(commit.sha);

  // develop 历史中有该提交
  const hist = await srv.api(`/api/works/${id}/history?branch=develop`);
  assert.equal(hist.history[0].message, '完成编辑器开发');

  // 无改动时提交应报错
  await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: 'x' }, expect: 400 });
});

test('发布: develop -> main 触发构建, main 推送即算一次更新', async () => {
  const created = await srv.api('/api/works', {
    method: 'POST',
    body: { title: '发布测试' },
  });
  const id = created.work.id;

  // 先提交一个改动(main 已随作品初始化, 无新提交时发布会报"没有新更新")
  await srv.api(`/api/works/${id}/file`, { method: 'PUT', body: { path: 'main.cpp', content: '// 发布 v1\n' } });
  await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: '发布准备' } });
  await srv.api(`/api/works/${id}/publish`, { method: 'POST' });

  // 等待构建完成(hook -> webhook -> 流水线全程异步)
  const finalWork = await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: '构建结束' });

  // 无论工具链是否存在, main 推送都应: 记录更新时间与发布提交
  assert.ok(finalWork.publishedSha, '应记录发布提交');
  assert.ok(finalWork.lastUpdate > 0, '应记录更新时间');
  assert.ok(['success', 'failed'].includes(finalWork.buildStatus), `构建状态应为终态, 实际 ${finalWork.buildStatus}`);

  // runSha 与构建结果一致: 成功时运行最新提交; 失败时回退最近一次有效构建(无则 null)
  if (finalWork.buildStatus === 'success') {
    assert.equal(finalWork.runSha, finalWork.publishedSha, '构建成功时运行版本 = 最新提交');
    // 工具链可用时产物应就位
    const dir = path.join(srv.dataDir, 'artifacts', id, 'current');
    assert.ok(fs.existsSync(path.join(dir, 'index.html')), '应有 index.html');
  } else {
    assert.equal(finalWork.runSha, null, '从未构建成功时无可运行版本');
    // 工具链缺失时日志应给出 emcc 提示
    assert.match(finalWork.buildLog, /emcc|Emscripten/i);
  }

  // 再次发布(无新提交)应报错
  await srv.api(`/api/works/${id}/publish`, { method: 'POST', expect: 400 });

  return finalWork;
});

test('主页收录: 构建成功作品出现, 构建失败/草稿不出现', async () => {
  // 发布一个作品(main 是否有有效构建决定他人主页是否展示)
  const published = await srv.api('/api/works', { method: 'POST', body: { title: '已发布作品' } });
  await srv.api(`/api/works/${published.work.id}/file`, { method: 'PUT', body: { path: 'main.cpp', content: '// 主页收录测试\n' } });
  await srv.api(`/api/works/${published.work.id}/commit`, { method: 'POST', body: { message: 'init' } });
  await srv.api(`/api/works/${published.work.id}/publish`, { method: 'POST' });
  const finalWork = await poll(async () => {
    const d = await srv.api(`/api/works/${published.work.id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: '构建结束' });

  const draft = await srv.api('/api/works', { method: 'POST', body: { title: '未发布草稿' } });

  const home = await srv.api('/api/works');
  const ids = home.works.map((w) => w.id);
  if (finalWork.buildStatus === 'success') {
    assert.ok(ids.includes(published.work.id), '构建成功的作品应出现在主页');
  } else {
    assert.ok(!ids.includes(published.work.id), '无有效构建(构建失败)的作品不应出现在主页');
  }
  assert.ok(!ids.includes(draft.work.id), '主页不应包含草稿');

  // 草稿对非本人不可见
  srv.setToken('');
  await srv.api(`/api/works/${draft.work.id}`, { expect: 404 });
  await login(srv, '张三');
});

test('权限: 不能修改/发布他人的作品', async () => {
  const mine = await srv.api('/api/works', { method: 'POST', body: { title: '我的作品' } });
  // 换一个创作者
  await login(srv, '李四');
  await srv.api(`/api/works/${mine.work.id}`, { method: 'PUT', body: { title: '篡改' }, expect: 403 });
  await srv.api(`/api/works/${mine.work.id}/publish`, { method: 'POST', expect: 403 });
  await srv.api(`/api/works/${mine.work.id}`, { method: 'DELETE', expect: 403 });
  await login(srv, '张三');
});

test('上传资源文件到 assets/', async () => {
  const created = await srv.api('/api/works', { method: 'POST', body: { title: '上传测试' } });
  const id = created.work.id;
  const form = new FormData();
  form.append('file', new Blob(['fake-image-bytes'], { type: 'text/plain' }), 'icon.txt');
  const d = await srv.api(`/api/works/${id}/upload`, { method: 'POST', form });
  assert.equal(d.path, 'assets/icon.txt');
  const files = await srv.api(`/api/works/${id}/files`);
  assert.ok(files.files.some((f) => f.path === 'assets/icon.txt'));
});

test('git 远程信息与工作区同步', async () => {
  const created = await srv.api('/api/works', { method: 'POST', body: { title: 'git 说明' } });
  const id = created.work.id;
  const info = await srv.api(`/api/works/${id}/git`);
  assert.ok(info.remote.includes(id), '远程地址应包含作品 ID');
  // 工作区干净时同步应成功
  await srv.api(`/api/works/${id}/sync`, { method: 'POST' });
});

test('删除作品: 仓库与记录一并清理', async () => {
  const created = await srv.api('/api/works', { method: 'POST', body: { title: '待删除' } });
  const id = created.work.id;
  await srv.api(`/api/works/${id}`, { method: 'DELETE' });
  // 数据库记录消失
  await srv.api(`/api/works/${id}`, { expect: 404 });
  // 仓库目录被清理
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'repos', `${id}.git`)));
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'worktrees', id)));
  // 我的作品列表不再包含
  const me = await srv.api('/api/me');
  assert.ok(!me.works.some((w) => w.id === id));
});

test('git 命令行推送 main 也能触发发布(hook 全链路)', async () => {
  // 模拟外部创作者: 通过平台内置 git-over-HTTP 克隆, 在 develop 上开发, 推送 main 发布。
  // 注意: 必须用异步 execFile —— 同步版本会阻塞事件循环,
  // 导致 hook 里的 curl 无法得到平台响应而形成死锁。
  // 远程地址需要认证: 用户名 = 创作者名称, 密码 = 账号密码; 禁用交互式凭据提示。
  await login(srv, '张三');
  const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const created = await srv.api('/api/works', { method: 'POST', body: { title: '命令行作品' } });
  const id = created.work.id;
  const info = await srv.api(`/api/works/${id}/git`);
  const remote = new URL(info.remote);
  remote.username = '张三';
  remote.password = 'test-pass-1234';

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cppp-clone-'));
  try {
    await execFileP('git', ['clone', remote.href, 'repo'], { cwd: tmp, encoding: 'utf8', windowsHide: true, env: GIT_ENV });
    const repo = path.join(tmp, 'repo');
    await execFileP('git', ['config', 'user.name', '命令行创作者'], { cwd: repo, encoding: 'utf8', windowsHide: true, env: GIT_ENV });
    await execFileP('git', ['config', 'user.email', 'cli@local'], { cwd: repo, encoding: 'utf8', windowsHide: true, env: GIT_ENV });
    fs.writeFileSync(path.join(repo, 'CLI.md'), '# 由命令行添加\n');
    await execFileP('git', ['add', '-A'], { cwd: repo, encoding: 'utf8', windowsHide: true, env: GIT_ENV });
    await execFileP('git', ['commit', '-m', '命令行提交'], { cwd: repo, encoding: 'utf8', windowsHide: true, env: GIT_ENV });
    // 先推送 develop(内部, 不公开)
    await execFileP('git', ['push', 'origin', 'develop'], { cwd: repo, encoding: 'utf8', windowsHide: true, env: GIT_ENV });
    let w = await srv.api(`/api/works/${id}`);
    assert.equal(w.work.publishedSha, null, 'develop 推送不应公开作品');

    // 再推送 main -> 应触发 hook -> 自动构建。
    // main 分支已随作品初始化, 用 refspec 形式推送(与平台文档给创作者的命令一致)
    await execFileP('git', ['push', 'origin', 'develop:main'], { cwd: repo, encoding: 'utf8', windowsHide: true, env: GIT_ENV });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  const finalWork = await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: 'hook 触发的构建结束' });

  assert.ok(finalWork.publishedSha, 'hook 应触发发布流水线');
  assert.ok(finalWork.lastUpdate > 0, '应记录更新时间');
  assert.ok(finalWork.runSha, '构建绑定到提交, 应有运行版本');
});
