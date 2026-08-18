import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { login, makeStubCompiler, poll, startServer } from './helpers.js';

/**
 * 构建与 Git Commit 绑定规则专项测试(使用假编译器, 构建结果确定可控):
 *   - 每次 main 推送触发构建, 构建结果绑定到该提交(works.buildStatus / builds 表)
 *   - 规则: 最新提交构建失败时, 运行版本回退到最近一次有效构建(runSha)
 *   - 规则: main 分支没有任何有效构建的作品, 不显示在他人主页; 自己主页按状态显示
 *   - 规则: 未发布(私有)作品: 主页不出现, 自己主页显示私有, 他人详情 404
 *   - 规则: 重新构建成功后可恢复公开与运行
 */
let srv;

before(async () => {
  srv = await startServer({ compiler: makeStubCompiler() });
});

after(async () => {
  await srv.close();
});

/** 创建作品并发布一个成功版本, 返回 { id, v1Sha } */
async function createPublished(title) {
  const created = await srv.api('/api/works', { method: 'POST', body: { title } });
  const id = created.work.id;
  await srv.api(`/api/works/${id}/file`, { method: 'PUT', body: { path: 'main.cpp', content: `// ${title} v1\n` } });
  await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: 'v1' } });
  await srv.api(`/api/works/${id}/publish`, { method: 'POST' });
  const w = await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: `v1 构建结束(${title})` });
  assert.equal(w.buildStatus, 'success', 'v1 应构建成功');
  return { id, v1Sha: w.publishedSha };
}

test('构建与提交绑定: 最新提交构建失败 -> 显示最近一次有效构建', async () => {
  await login(srv, '构建测试员');
  const { id, v1Sha } = await createPublished('绑定测试');

  // v1 构建成功: 运行版本 = 最新提交, 主页可见
  let w = (await srv.api(`/api/works/${id}`)).work;
  assert.equal(w.runSha, w.publishedSha, '构建成功时运行版本 = 最新提交');
  assert.ok(w.runSha);
  let home = await srv.api('/api/works');
  assert.ok(home.works.some((x) => x.id === id), '存在有效构建 -> 他人主页可见');
  let me = await srv.api('/api/me');
  assert.equal(me.works.find((x) => x.id === id).buildStatus, 'success', '自己主页显示已发布');

  // 推入构建失败的 v2(快照含 FAIL 文件)
  await srv.api(`/api/works/${id}/file`, { method: 'PUT', body: { path: 'FAIL', content: 'x' } });
  await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: 'v2 坏提交' } });
  await srv.api(`/api/works/${id}/publish`, { method: 'POST' });
  w = await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: 'v2 构建结束' });

  assert.equal(w.buildStatus, 'failed', 'v2 构建应失败并绑定到新提交');
  assert.notEqual(w.publishedSha, v1Sha, '发布提交应更新为 v2');
  assert.equal(w.runSha, v1Sha, '最新提交构建失败 -> 运行最近一次有效构建(v1)');

  // 他人主页: main 仍有有效构建 -> 依然可见(最新失败不影响已存在有效构建)
  home = await srv.api('/api/works');
  assert.ok(home.works.some((x) => x.id === id), '存在历史有效构建 -> 他人主页仍可见');

  // 自己主页: 有提交但绑定失败构建 -> 构建失败
  me = await srv.api('/api/me');
  assert.equal(me.works.find((x) => x.id === id).buildStatus, 'failed', '自己主页显示构建失败');

  // 修复后重新发布 v3(移除 FAIL) -> 恢复成功, 运行 v3
  await srv.api(`/api/works/${id}/file`, { method: 'DELETE', body: { path: 'FAIL' } });
  await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: 'v3 修复' } });
  await srv.api(`/api/works/${id}/publish`, { method: 'POST' });
  w = await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: 'v3 构建结束' });

  assert.equal(w.buildStatus, 'success', '修复后构建应成功');
  assert.equal(w.runSha, w.publishedSha, 'v3 构建成功 -> 运行版本 = 最新提交');
  assert.notEqual(w.runSha, v1Sha, '应运行 v3 而非旧的有效构建');
});

test('私有作品: 主页不出现, 自己主页显示私有, 他人详情 404', async () => {
  await login(srv, '构建测试员');
  const created = await srv.api('/api/works', { method: 'POST', body: { title: '私有作品' } });
  const id = created.work.id;

  // 自己主页: main 从未推送 -> 私有(buildStatus none)
  const me = await srv.api('/api/me');
  assert.equal(me.works.find((x) => x.id === id).buildStatus, 'none', '未发布作品显示私有');
  const detail = await srv.api(`/api/works/${id}`);
  assert.equal(detail.work.runSha, null, '私有作品无可运行版本');

  // 他人主页与全部作品均不出现
  const home = await srv.api('/api/works');
  assert.ok(!home.works.some((x) => x.id === id), '私有作品不应出现在主页');
  const all = await srv.api('/api/works/all');
  assert.ok(!all.works.some((x) => x.id === id), '私有作品不应出现在全部作品');

  // 他人访问详情 -> 404
  await login(srv, '路人甲');
  await srv.api(`/api/works/${id}`, { expect: 404 });
});

test('手动重新构建: 对同一提交重新构建, 失败可恢复为成功', async () => {
  await login(srv, '构建测试员');
  const created = await srv.api('/api/works', { method: 'POST', body: { title: '重构建测试' } });
  const id = created.work.id;
  await srv.api(`/api/works/${id}/file`, { method: 'PUT', body: { path: 'FAIL', content: 'x' } });
  await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: '坏版本' } });
  await srv.api(`/api/works/${id}/publish`, { method: 'POST' });
  let w = await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: '失败构建结束' });
  assert.equal(w.buildStatus, 'failed');
  const sha = w.publishedSha;

  // 修复: 移除 FAIL 并提交, 重新发布(触发对新提交的构建)
  await srv.api(`/api/works/${id}/file`, { method: 'DELETE', body: { path: 'FAIL' } });
  await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: '移除 FAIL' } });
  await srv.api(`/api/works/${id}/publish`, { method: 'POST' });
  w = await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: '重建结束' });
  assert.equal(w.buildStatus, 'success', '修复后重新发布应成功');
  assert.notEqual(w.publishedSha, sha, '新提交绑定新构建');

  // 手动 /build 对同一提交重新构建: 状态刷新, 绑定不变的 sha
  await srv.api(`/api/works/${id}/build`, { method: 'POST' });
  const rebuilt = await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: '手动重构建结束' });
  assert.equal(rebuilt.buildStatus, 'success');
  assert.equal(rebuilt.publishedSha, w.publishedSha, '重构建绑定同一提交');
});
