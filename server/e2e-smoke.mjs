/**
 * 端到端冒烟测试 —— 验证「前端 SSR/SEO 输出」与「后端 API/构建流水线」的完整链路。
 *
 * 前置条件: 生产栈已启动(Express 3000 + Next.js standalone 3010):
 *   node server/src/start-all.js
 * 用法: node server/e2e-smoke.mjs
 *
 * 流程: 注册 -> 创建作品 -> 修改源码 -> 提交 -> 发布(emcc 构建) ->
 *       轮询构建完成 -> 校验主页/作品页/创作者页 SSR、JSON-LD、sitemap、运行产物。
 */
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failures++;
}

const j = async (p, o = {}) => {
  const res = await fetch(BASE + p, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const txt = await res.text();
  let data = {};
  try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 120) }; }
  return { status: res.status, data };
};
const html = async (p) => (await fetch(BASE + p)).text();

// 健康检查
const health = await j('/api/health');
check('后端健康检查', health.status === 200 && health.data.ok === true);

// 注册 + 验证 + 登录
const uname = `冒烟${Date.now().toString(36)}`;
const reg = await j('/api/auth/register', { method: 'POST', body: { username: uname, password: 'test-pass-1234', email: `${uname}@smoke.local` } });
check('注册(开发模式返回验证令牌)', reg.status === 200 && !!reg.data.verificationToken);
await j('/api/auth/verify', { method: 'POST', body: { token: reg.data.verificationToken } });
const login = await j('/api/auth/login', { method: 'POST', body: { account: uname, password: 'test-pass-1234' } });
check('登录', login.status === 200 && !!login.data.token);
const auth = { Authorization: `Bearer ${login.data.token}` };

// 创建作品 -> 修改 main.cpp -> 提交 -> 发布(触发 emcc 构建)
const created = await j('/api/works', { method: 'POST', body: { title: 'SSR 冒烟作品', description: '端到端验证: SSR 与结构化数据' }, headers: auth });
check('创建作品', created.status === 200 && !!created.data.work?.id);
const id = created.data.work.id;
const files = await j(`/api/works/${id}/files`, { headers: auth });
const target = files.data.files.find((f) => f.path.endsWith('.cpp'))?.path || 'main.cpp';
const cur = await j(`/api/works/${id}/file?path=${encodeURIComponent(target)}`, { headers: auth });
await j(`/api/works/${id}/file`, { method: 'PUT', body: { path: target, content: cur.data.content + '\n// smoke\n' }, headers: auth });
await j(`/api/works/${id}/commit`, { method: 'POST', body: { message: 'smoke' }, headers: auth });
await j(`/api/works/${id}/publish`, { method: 'POST', headers: auth });

let work = null;
for (let i = 0; i < 60; i++) {
  await sleep(3000);
  const d = await j(`/api/works/${id}`, { headers: auth });
  work = d.data.work;
  if (work && (work.buildStatus === 'success' || work.buildStatus === 'failed')) break;
}
check(`构建成功(${work?.buildStatus})`, work?.buildStatus === 'success');

// —— 前端 SSR / SEO 校验 ——
const home = await html('/');
check('主页 SSR 含作品标题', home.includes('SSR 冒烟作品'));
check('主页内联 hero', home.includes('class="hero"'));

const workHtml = await html(`/work/${id}`);
check('作品页含标题', workHtml.includes('SSR 冒烟作品'));
check('作品页 JSON-LD(CreativeWork)', workHtml.includes('application/ld+json') && workHtml.includes('CreativeWork'));
check('作品页 meta description', workHtml.includes('端到端验证: SSR 与结构化数据'));
check('作品页 <title> 模板', (workHtml.match(/<title>([^<]*)<\/title>/) || [])[1]?.includes('· 创玩'));
check('作品页 og:title', (workHtml.match(/property="og:title" content="([^"]*)"/) || [])[1]?.includes(uname));
check('作品页 canonical', (workHtml.match(/rel="canonical" href="([^"]*)"/) || [])[1]?.includes(`/work/${id}`));

const creatorHtml = await html(`/creator/${encodeURIComponent(uname)}`);
check('创作者页含作品', creatorHtml.includes('SSR 冒烟作品'));
check('创作者页 JSON-LD(ProfilePage)', creatorHtml.includes('ProfilePage'));

const sitemap = await (await fetch(BASE + '/sitemap.xml')).text();
check('sitemap 含作品 URL', sitemap.includes(`/work/${id}`));
check('sitemap 含创作者 URL', sitemap.includes('/creator/'));

const robots = await (await fetch(BASE + '/robots.txt')).text();
check('robots.txt 指向 sitemap', robots.includes('/sitemap.xml'));

const artifact = await fetch(BASE + `/w/${id}/`).then((r) => r.status);
check('作品运行产物 /w/<id>/ 可访问', artifact === 200);

const notFound = await fetch(BASE + '/work/w00000000').then((r) => r.status);
check('不存在作品返回 404', notFound === 404);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
