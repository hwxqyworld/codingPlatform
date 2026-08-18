import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createDb } from '../src/db.js';
import { login, makeStubCompiler, poll, startServer } from './helpers.js';

/**
 * 主页收录规则专项测试:
 *   - 最近 30 天内有更新且 main 存在"构建成功"提交的作品出现在主页
 *   - 按最近更新时间倒序, 不按热度排序(人人平等曝光)
 *   - 构建与提交绑定: 无任何有效构建的作品不展示(他人主页), 自己主页显示构建失败
 *
 * 使用假编译器(始终成功/可标记失败), 使构建结果确定可控, 不依赖本机 emcc。
 */
let srv;
let db; // 第二个数据库连接, 用于直接改写更新时间模拟"过期"

before(async () => {
  srv = await startServer({ compiler: makeStubCompiler() });
  db = createDb({ dataDir: srv.dataDir, dbFile: path.join(srv.dataDir, 'platform.db') });
});

after(async () => {
  db.close();
  await srv.close();
});

/** 创建并发布一个作品(提交一个改动后再发布), 返回其 id */
async function createPublished(title) {
  const created = await srv.api('/api/works', { method: 'POST', body: { title } });
  const id = created.work.id;
  await srv.api(`/api/works/${id}/file`, { method: 'PUT', body: { path: 'main.cpp', content: `// ${title}\n` } });
  await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: 'init' } });
  await srv.api(`/api/works/${id}/publish`, { method: 'POST' });
  await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building';
  }, { desc: `构建结束(${title})` });
  return id;
}

test('主页规则: 近 30 天有更新的作品全部收录, 过期的移除, 按更新时间倒序', async () => {
  await login(srv, '主页测试员');
  const DAY = 24 * 3600 * 1000;

  // 三个作品, 发布后改写各自的"最近更新时间"
  const a = await createPublished('作品A(刚刚更新)');
  const b = await createPublished('作品B(31 天前, 过期)');
  const c = await createPublished('作品C(29 天前, 仍有效)');

  db.setLastUpdateRaw(a, Date.now());
  db.setLastUpdateRaw(b, Date.now() - 31 * DAY);
  db.setLastUpdateRaw(c, Date.now() - 29 * DAY);

  const home = await srv.api('/api/works');
  assert.equal(home.windowDays, 30);
  const ids = home.works.map((w) => w.id);

  // 30 天窗口内的作品都应出现(同等曝光), 过期的必须消失
  assert.ok(ids.includes(a), '刚刚更新的作品应在主页');
  assert.ok(ids.includes(c), '29 天前更新的作品仍应在主页');
  assert.ok(!ids.includes(b), '31 天前更新的作品不应出现在主页');

  // 按更新时间倒序
  const times = home.works.map((w) => w.lastUpdate);
  assert.deepEqual(times, [...times].sort((x, y) => y - x), '应严格按更新时间倒序');

  // 平等曝光: 响应中不得出现热度/浏览量/点赞等字段
  for (const w of home.works) {
    for (const hot of ['views', 'likes', 'hot', 'popularity', 'score']) {
      assert.ok(!(hot in w), `作品响应不应包含热度字段 ${hot}`);
    }
  }
});

test('全部作品接口包含过期作品, 草稿始终不公开', async () => {
  const all = await srv.api('/api/works/all');
  const home = await srv.api('/api/works');
  const homeIds = new Set(home.works.map((w) => w.id));
  const allIds = new Set(all.works.map((w) => w.id));

  // 31 天前的作品不在主页, 但仍在"全部作品"中
  assert.ok(all.works.some((w) => !homeIds.has(w.id)), '全部作品应包含主页之外的过期作品');
  // 主页收录的作品必然已公开(全部作品应覆盖主页)
  for (const id of homeIds) {
    assert.ok(allIds.has(id), '主页作品应包含在全部作品中');
  }
});

test('构建与提交绑定: 无任何有效构建的作品不展示, 自己主页显示构建失败', async () => {
  await login(srv, '主页测试员');
  const created = await srv.api('/api/works', { method: 'POST', body: { title: '从未构建成功' } });
  const id = created.work.id;

  // 推入一个必然失败的版本(快照中存在 FAIL 文件 -> 假编译器返回失败)
  await srv.api(`/api/works/${id}/file`, { method: 'PUT', body: { path: 'FAIL', content: 'x' } });
  await srv.api(`/api/works/${id}/commit`, { method: 'POST', body: { message: '坏提交' } });
  await srv.api(`/api/works/${id}/publish`, { method: 'POST' });
  const work = await poll(async () => {
    const d = await srv.api(`/api/works/${id}`);
    return d.work.buildStatus !== 'building' ? d.work : null;
  }, { desc: '失败构建结束' });
  assert.equal(work.buildStatus, 'failed', '构建应与提交绑定并失败');
  assert.equal(work.runSha, null, '从未构建成功时无可运行版本');

  // 他人主页不展示(无有效构建)
  const home = await srv.api('/api/works');
  assert.ok(!home.works.some((w) => w.id === id), '无有效构建的作品不应出现在主页');
  const all = await srv.api('/api/works/all');
  assert.ok(!all.works.some((w) => w.id === id), '无有效构建的作品不应出现在全部作品');

  // 自己的主页: 有提交但绑定失败构建 -> 显示"构建失败"
  const me = await srv.api('/api/me');
  const my = me.works.find((w) => w.id === id);
  assert.ok(my, '自己的列表应包含该作品');
  assert.equal(my.buildStatus, 'failed', '自己主页应显示构建失败');
  assert.equal(my.publishedSha, work.publishedSha, '应记录发布提交');
});
