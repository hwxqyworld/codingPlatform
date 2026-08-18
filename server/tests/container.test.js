import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { makeFakeDocker } from './fakeDocker.js';
import { login, poll, startServer } from './helpers.js';

/**
 * 容器模式测试 —— 构建容器池 / 排队 / 扩容缩容 / 容器内 git / 超时 / 启动恢复。
 * 全部使用注入的假 Docker 客户端, 不依赖真实 Docker。
 */

// ---------------- 容器模式全链路(成功) ----------------

test('容器模式全链路: 创建->编辑->提交->发布->构建成功->产物落盘', async () => {
  const { docker, calls } = makeFakeDocker({ build: { ok: true, log: 'fake build ok' } });
  const srv = await startServer({
    buildMode: 'container',
    docker,
    buildTimeoutMs: 5000,
    scaleDownIdleMs: 100000,
  });
  try {
    await login(srv, '甲');

    // 创建作品: git 初始化走容器(runOnce 一次性容器)
    const created = await srv.api('/api/works', {
      method: 'POST',
      body: { title: '容器构建测试' },
    });
    const workId = created.work.id;
    const initCall = calls.runOnce.find((c) => (c.script || '').includes('init --bare'));
    assert.ok(initCall, '应有一次容器内 git init');
    assert.ok(initCall.script.includes('branch main develop'), '应初始化 main 分支');
    assert.ok(initCall.script.includes('reset --hard develop'), '应物化编辑器目录');
    assert.equal(initCall.binds.length, 3, '应挂载 数据目录/模板目录/编辑器目录');
    assert.ok(initCall.binds.every((b) => !b.ro), '初始化挂载应为可写');

    // 编辑 + 提交(容器内 git)
    await srv.api(`/api/works/${workId}/file`, {
      method: 'PUT',
      body: { path: 'main.cpp', content: '// hi' },
    });
    await srv.api(`/api/works/${workId}/commit`, { method: 'POST', body: { message: '提交' } });
    const commitCall = calls.runOnce.find(
      (c) => (c.script || '').includes('commit -m') && c.binds?.some((b) => b.container === '/repo'),
    );
    assert.ok(commitCall, '提交应走容器内 git');
    assert.equal(commitCall.scriptArgs[0], '甲', '作者名应经 argv 传入(免注入)');
    assert.equal(commitCall.scriptArgs[1], '提交', '提交信息应经 argv 传入');
    assert.ok(commitCall.binds.some((b) => b.container === '/repo' && !b.ro), '提交应挂载可写裸仓库');
    assert.ok(commitCall.binds.some((b) => b.container === '/worktree' && !b.ro), '提交应挂载可写编辑器目录');

    // 发布(容器内 push) -> 平台直接触发构建
    await srv.api(`/api/works/${workId}/publish`, { method: 'POST' });
    const pushCall = calls.runOnce.find((c) => [...(c.cmd || [])].join(' ').includes('push origin develop:main'));
    assert.ok(pushCall, '发布应走容器内 git push');
    assert.ok(pushCall.binds.some((b) => b.container === '/repo' && !b.ro), 'push 应挂载可写裸仓库');

    // 构建: 排队 -> 构建中 -> 成功
    const d = await poll(async () => {
      const w = (await srv.api(`/api/works/${workId}`)).work;
      return w.buildStatus === 'success' ? w : null;
    }, { desc: '构建成功' });
    assert.equal(d.buildLog.includes('fake build ok'), true, '日志来自容器 status.json');

    // 产物落盘(atomic 替换到 current)
    const current = path.join(srv.dataDir, 'artifacts', workId, 'current');
    assert.ok(fs.existsSync(path.join(current, 'index.html')), 'index.html 应已安装');
    assert.ok(fs.existsSync(path.join(current, 'index.js')), 'index.js 应已安装');
    assert.ok(!fs.existsSync(path.join(current, 'status.json')), 'status.json 不应进入产物');

    // 任务流: 裸仓库经 tar 拷入, 产物经 tar 拷出
    assert.equal(calls.putTar.length, 1, '应拷入一次裸仓库');
    assert.equal(calls.getTar.length, 1, '应拷出一次产物');

    // 池: 初始 1 个热备, 任务认领后补建 -> 2 个
    assert.equal(calls.createWorker.length, 2, '热备 + 补建 = 2 个容器');
    const bq = srv.app.locals.buildQueue;
    const st = bq.stats();
    assert.equal(st.pending, 0);
  } finally {
    await srv.close();
  }
});

test('容器模式构建失败: status.json ok=false -> failed, 产物不落盘, 残留全清除', async () => {
  const { docker, calls } = makeFakeDocker({ build: { ok: false, log: 'fake build failure' } });
  const srv = await startServer({ buildMode: 'container', docker, buildTimeoutMs: 5000 });
  try {
    await login(srv, '乙');
    const created = await srv.api('/api/works', { method: 'POST', body: { title: '失败测试' } });
    await srv.api(`/api/works/${created.work.id}/publish`, { method: 'POST' });
    const d = await poll(async () => {
      const w = (await srv.api(`/api/works/${created.work.id}`)).work;
      return w.buildStatus === 'failed' ? w : null;
    }, { desc: '构建失败' });
    assert.equal(d.buildLog.includes('fake build failure'), true);
    const workArtifacts = path.join(srv.dataDir, 'artifacts', created.work.id);
    // 未持久化部分必须全部清除: 无 .staging-* 临时产物目录
    const leftovers = fs
      .readdirSync(workArtifacts)
      .filter((e) => e.startsWith('.staging-'));
    assert.equal(leftovers.length, 0, '失败构建不应残留 .staging-* 临时产物');
    assert.ok(!fs.existsSync(path.join(workArtifacts, 'current', 'index.html')), '失败不应落盘产物');
    // 失败任务: 容器内执行过用户代码, 必须销毁, 池自愈回 1 个热备
    assert.ok(calls.remove.length >= 1, '失败构建的容器应被销毁');
    await poll(async () => srv.app.locals.buildQueue.stats().workers === 1, {
      desc: '池自愈回 1 个热备',
    });
  } finally {
    await srv.close();
  }
});

test('容器模式构建超时: 60s 上限, 超时容器被销毁并补建', async () => {
  const { docker, calls } = makeFakeDocker({ build: { timedOut: true } });
  const srv = await startServer({
    buildMode: 'container',
    docker,
    buildTimeoutMs: 100, // 测试用极小超时
    scaleDownIdleMs: 100000,
  });
  try {
    await login(srv, '丙');
    const created = await srv.api('/api/works', { method: 'POST', body: { title: '超时测试' } });
    await srv.api(`/api/works/${created.work.id}/publish`, { method: 'POST' });
    const d = await poll(async () => {
      const w = (await srv.api(`/api/works/${created.work.id}`)).work;
      return w.buildStatus === 'failed' ? w : null;
    }, { desc: '超时失败' });
    assert.match(d.buildLog, /构建超时/, '日志应包含超时提示');
    // 超时容器被销毁, 池自动补建回热备
    await poll(async () => (srv.app.locals.buildQueue.stats().workers === 1), {
      desc: '池恢复 1 个热备',
    });
    assert.equal(calls.kill.length >= 1, true, '应有容器被杀');
  } finally {
    await srv.close();
  }
});

// ---------------- 排队与位置 ----------------

test('排队: 构建繁忙时新任务排队, 前端可读队伍位置', async () => {
  // workerGate: 第 2 个容器(热备)创建被挂起, 确保第 2 个任务确定地进入队列
  let releaseWorker;
  const gate = new Promise((r) => (releaseWorker = r));
  const { docker } = makeFakeDocker({
    build: { hang: true },
    workerGate: { promise: gate, release: releaseWorker, after: 1 }, // 第 1 个(启动热备)放行, 第 2 个(补建)挂起
  });
  const srv = await startServer({ buildMode: 'container', docker, buildTimeoutMs: 60000 });
  try {
    await login(srv, '丁');
    const w1 = (await srv.api('/api/works', { method: 'POST', body: { title: '任务1' } })).work;
    const w2 = (await srv.api('/api/works', { method: 'POST', body: { title: '任务2' } })).work;

    // 任务1 认领唯一热备容器并开始构建(挂起)
    await srv.api(`/api/works/${w1.id}/publish`, { method: 'POST' });
    await poll(async () => {
      const w = (await srv.api(`/api/works/${w1.id}`)).work;
      return w.buildStatus === 'building' ? w : null;
    }, { desc: '任务1 构建中' });

    // 任务2: 热备容器被任务1 占用(补建被 gate 挂起) -> 排队
    await srv.api(`/api/works/${w2.id}/publish`, { method: 'POST' });
    const d = await poll(async () => {
      const w = (await srv.api(`/api/works/${w2.id}`)).work;
      return w.buildStatus === 'queued' && w.queuePosition > 0 ? w : null;
    }, { desc: '任务2 排队' });
    assert.equal(d.queuePosition, 1, '队伍位置应为 1');

    // 释放 gate: 补建容器就绪 -> 任务2 自动开始构建(不再排队)
    releaseWorker();
    await poll(async () => {
      const w = (await srv.api(`/api/works/${w2.id}`)).work;
      return w.buildStatus === 'building' ? w : null;
    }, { desc: '任务2 开始构建' });
    const after = (await srv.api(`/api/works/${w2.id}`)).work;
    assert.equal(after.queuePosition, null, '开始构建后不再有队伍位置');
  } finally {
    await srv.close();
  }
});

test('排队去重: 同一作品重复发布只入队一次', async () => {
  const { docker, calls } = makeFakeDocker({ build: { hang: true } });
  const srv = await startServer({ buildMode: 'container', docker, buildTimeoutMs: 60000 });
  try {
    await login(srv, '戊');
    const created = await srv.api('/api/works', { method: 'POST', body: { title: '去重' } });
    const id = created.work.id;
    await srv.api(`/api/works/${id}/publish`, { method: 'POST' });
    await srv.api(`/api/works/${id}/publish`, { method: 'POST' }); // 重复触发
    await poll(async () => {
      const w = (await srv.api(`/api/works/${id}`)).work;
      return w.buildStatus === 'building' ? w : null;
    }, { desc: '开始构建' });
    const bq = srv.app.locals.buildQueue;
    assert.equal(bq.stats().pending, 0, '重复发布不应产生新任务');
    assert.ok(calls.putTar.length <= 1, '裸仓库只拷入一次');
  } finally {
    await srv.close();
  }
});

// ---------------- 扩容与缩容 ----------------

test('扩容: 排队超过 5 个任务 -> 池扩到 3 个', async () => {
  const { docker } = makeFakeDocker({ build: { hang: true } });
  const srv = await startServer({
    buildMode: 'container',
    docker,
    buildTimeoutMs: 60000,
    scaleUpQueueLen: 5,
    poolMax: 3,
    scaleDownIdleMs: 100000,
  });
  try {
    await login(srv, '己');
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const created = await srv.api('/api/works', { method: 'POST', body: { title: `任务${i}` } });
      ids.push(created.work.id);
    }
    for (const id of ids) await srv.api(`/api/works/${id}/publish`, { method: 'POST' });

    const bq = srv.app.locals.buildQueue;
    // 2 个任务占满自动扩容线(1 热备 + 补建 1), 其余排队; 队列 >5 -> 扩容到 3
    await poll(async () => bq.stats().workers === 3, { desc: '扩容到 3 个容器' });
    await poll(async () => bq.stats().running === 3, { desc: '3 个并发构建' });
    const st = bq.stats();
    assert.ok(st.pending > 0, '剩余任务排队中');
    assert.ok(st.pending <= 5, `排队数不应超过 5(当前 ${st.pending})`);
  } finally {
    await srv.close();
  }
});

test('缩容: 队空持续 300s(测试用短值) -> 销毁空闲容器回到 1 个热备', async () => {
  const { docker, calls } = makeFakeDocker({ build: { ok: true, log: 'ok' } });
  const srv = await startServer({
    buildMode: 'container',
    docker,
    buildTimeoutMs: 5000,
    scaleDownIdleMs: 60, // 测试用 60ms
  });
  try {
    await login(srv, '庚');
    const created = await srv.api('/api/works', { method: 'POST', body: { title: '缩容' } });
    await srv.api(`/api/works/${created.work.id}/publish`, { method: 'POST' });
    await poll(async () => {
      const w = (await srv.api(`/api/works/${created.work.id}`)).work;
      return w.buildStatus === 'success' ? w : null;
    }, { desc: '构建成功' });
    // 构建期间池为 2(热备 + 补建), 队空后缩容回 1
    await poll(async () => srv.app.locals.buildQueue.stats().workers === 1, {
      desc: '缩容回 1 个热备',
      timeout: 5000,
    });
    assert.ok(calls.remove.length >= 1, '应有容器被销毁');
  } finally {
    await srv.close();
  }
});

// ---------------- 容器内 git 细节 ----------------

test('容器内 git: 同步/历史/headSha 均走容器且挂载正确', async () => {
  const { docker, calls } = makeFakeDocker({ build: { ok: true, log: 'ok' } });
  const srv = await startServer({ buildMode: 'container', docker, buildTimeoutMs: 5000, scaleDownIdleMs: 100000 });
  try {
    await login(srv, '辛');
    const created = await srv.api('/api/works', { method: 'POST', body: { title: 'git容器化' } });
    const id = created.work.id;

    // 同步(注意排除 init 脚本 —— init 也含 reset --hard, 但含 /data 挂载)
    await srv.api(`/api/works/${id}/sync`, { method: 'POST' });
    const syncCall = calls.runOnce.find(
      (c) => (c.script || '').includes('reset --hard develop') && !(c.script || '').includes('/data'),
    );
    assert.ok(syncCall, '同步应走容器内 git');
    assert.ok(syncCall.binds.some((b) => b.container === '/repo' && b.ro), '同步时仓库只读挂载');
    assert.ok(syncCall.binds.some((b) => b.container === '/worktree' && !b.ro), '同步时编辑器可写');

    // 历史
    await srv.api(`/api/works/${id}/history?branch=main`);
    const logCall = calls.runOnce.find((c) => [...(c.cmd || [])].join(' ').includes('log'));
    assert.ok(logCall, '历史应走容器内 git log');
    assert.ok(logCall.binds.every((b) => b.ro), '只读操作仓库只读挂载');

    // 发布构建时的 headSha
    await srv.api(`/api/works/${id}/publish`, { method: 'POST' });
    await poll(async () => {
      const w = (await srv.api(`/api/works/${id}`)).work;
      return w.buildStatus === 'success' ? w : null;
    }, { desc: '构建成功' });
    const headCall = calls.runOnce.find((c) => [...(c.cmd || [])].join(' ').includes('rev-parse'));
    assert.ok(headCall, '构建开始时应读 main 头部 sha(容器内)');
  } finally {
    await srv.close();
  }
});

test('符号链接防护: 编辑器目录中的符号链接被拒绝读取/列出', async (t) => {
  const srv = await startServer();
  try {
    await login(srv, '壬');
    const created = await srv.api('/api/works', { method: 'POST', body: { title: '链接防护' } });
    const id = created.work.id;
    // 模拟恶意仓库物化的符号链接(指向工作区外的敏感文件)
    const editor = path.join(srv.dataDir, 'worktrees', id);
    const secret = path.join(srv.dataDir, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET');
    let linkOk = true;
    try {
      fs.symlinkSync(secret, path.join(editor, 'evil-link.txt'));
    } catch {
      linkOk = false; // Windows 无开发者模式/权限时无法建链接 -> 跳过
    }
    if (!linkOk) {
      t.skip('当前环境无法创建符号链接(Windows 需开发者模式/管理员权限)');
      return;
    }

    // 文件树不应列出符号链接
    const files = await srv.api(`/api/works/${id}/files`);
    assert.ok(!files.files.some((f) => f.path === 'evil-link.txt'), '符号链接不应出现在文件树');

    // 读取被拒绝
    await srv.api(`/api/works/${id}/file?path=evil-link.txt`, { expect: 400 });

    // 写入同路径: 符号链接被替换为普通文件(可正常保存)
    await srv.api(`/api/works/${id}/file`, {
      method: 'PUT',
      body: { path: 'evil-link.txt', content: 'safe' },
    });
    const read = await srv.api(`/api/works/${id}/file?path=evil-link.txt`);
    assert.equal(read.content, 'safe');
    // 链接本身已被替换, 敏感文件未被动过
    assert.equal(fs.readFileSync(secret, 'utf8'), 'TOP-SECRET');
  } finally {
    await srv.close();
  }
});

// ---------------- 启动恢复 ----------------

test('启动恢复: 上次进程退出时排队中/构建中的作品重新入队', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cppp-recover-'));
  let app1 = null;
  let app2 = null;
  let server1 = null;
  let server2 = null;
  try {
    // 第一代进程: 正常创建作品后, 直接写入"构建中断"状态(模拟进程在构建中被杀)
    const { docker: docker1 } = makeFakeDocker({ build: { hang: true } });
    app1 = await createApp({
      dataDir,
      port: 0,
      buildMode: 'container',
      docker: docker1,
      buildTimeoutMs: 60000,
      scaleDownIdleMs: 100000,
    });
    server1 = app1.listen(0, '127.0.0.1');
    await once(server1, 'listening');
    app1.set('webhookUrl', `http://127.0.0.1:${server1.address().port}/api/internal/publish`);

    const base1 = `http://127.0.0.1:${server1.address().port}`;
    const reg1 = await fetch(`${base1}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '恢复者', password: 'test-pass-1234', email: 'fuzhe@test.local' }),
    }).then((r) => r.json());
    await fetch(`${base1}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: reg1.verificationToken }),
    });
    const login1 = await fetch(`${base1}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: '恢复者', password: 'test-pass-1234' }),
    }).then((r) => r.json());
    const created = await fetch(`${base1}/api/works`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
      body: JSON.stringify({ title: '恢复测试' }),
    }).then((r) => r.json());
    const id = created.work.id;
    // 模拟中断: 一个排队中 + 一个构建中
    app1.locals.db.setBuild(id, null, 'queued', '');
    app1.locals.db.setBuild(id, null, 'building', '中断日志');

    // 第二代进程: 相同数据目录 + 可正常构建的 docker -> 启动恢复重新入队
    const { docker: docker2 } = makeFakeDocker({ build: { ok: true, log: 'recovered' } });
    app2 = await createApp({
      dataDir,
      port: 0,
      buildMode: 'container',
      docker: docker2,
      buildTimeoutMs: 5000,
      scaleDownIdleMs: 100000,
    });
    server2 = app2.listen(0, '127.0.0.1');
    await once(server2, 'listening');
    app2.set('webhookUrl', `http://127.0.0.1:${server2.address().port}/api/internal/publish`);
    const base2 = `http://127.0.0.1:${server2.address().port}`;

    // 恢复后重新构建并成功
    const w = await poll(async () => {
      const d = await fetch(`${base2}/api/works/${id}`, {
        headers: { Authorization: `Bearer ${login1.token}` },
      }).then((r) => r.json());
      return d.work.buildStatus === 'success' ? d.work : null;
    }, { desc: '恢复后构建成功' });
    assert.equal(w.buildLog.includes('recovered'), true, '恢复的构建日志应来自新进程');
  } finally {
    for (const s of [server1, server2]) {
      if (s) await new Promise((r) => s.close(r)).catch(() => {});
    }
    for (const a of [app1, app2]) {
      try {
        await a?.locals.buildQueue?.stop();
      } catch {
        /* 忽略 */
      }
      try {
        a?.locals.db?.close();
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// ---------------- 模式检测 ----------------

test('启动清理: 上次进程残留的孤儿构建容器被销毁', async () => {
  const { docker, calls } = makeFakeDocker({ preExistingWorkers: 2 });
  const srv = await startServer({
    buildMode: 'container',
    docker,
    buildTimeoutMs: 5000,
    scaleDownIdleMs: 100000,
  });
  try {
    // start() 应先销毁 2 个孤儿容器, 再拉起 1 个热备
    await poll(async () => srv.app.locals.buildQueue.stats().workers === 1, {
      desc: '拉起 1 个热备',
    });
    assert.ok(calls.remove.includes('orphan-1'), '应销毁孤儿容器 orphan-1');
    assert.ok(calls.remove.includes('orphan-2'), '应销毁孤儿容器 orphan-2');
  } finally {
    await srv.close();
  }
});

test('启动清理: 上次进程残留的 .staging-* 临时产物目录被清除', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cppp-sweep-'));
  let app = null;
  try {
    // 模拟上次进程异常退出残留: 一个 .staging-* 目录(含恶意内容) + 一个正式产物 current
    const workDir = path.join(dataDir, 'artifacts', 'wdead');
    fs.mkdirSync(path.join(workDir, '.staging-abc'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.staging-abc', 'evil.txt'), 'x');
    fs.mkdirSync(path.join(workDir, 'current'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'current', 'index.html'), 'ok');

    app = await createApp({ dataDir, port: 0, buildMode: 'local' });
    const left = fs.readdirSync(workDir).sort();
    assert.deepEqual(left, ['current'], '残留 .staging-* 应被清除, 正式产物 current 保留');
    assert.equal(fs.readFileSync(path.join(workDir, 'current', 'index.html'), 'utf8'), 'ok');
  } finally {
    try {
      app?.locals.db?.close();
    } catch {
      /* 忽略 */
    }
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('模式检测: auto + Docker 可用且镜像存在 -> 容器模式', async () => {
  const { docker } = makeFakeDocker({ imageExists: true });
  const app = await createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cppp-mode-')), port: 0, buildMode: 'auto', docker });
  assert.equal(app.locals.buildQueue !== null, true, '容器模式应有构建队列');
  await app.locals.buildQueue.stop();
  app.locals.db.close();
});

test('模式检测: auto + 镜像缺失 -> 回退本地模式', async () => {
  const { docker } = makeFakeDocker({ imageExists: false });
  const app = await createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cppp-mode-')), port: 0, buildMode: 'auto', docker });
  assert.equal(app.locals.buildQueue, null, '本地模式不应有构建队列');
  app.locals.db.close();
});
