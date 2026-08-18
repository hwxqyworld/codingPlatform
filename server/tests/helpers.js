import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

/**
 * 假编译器: 默认总是构建成功; 若导出快照中存在 FAIL 文件则构建失败。
 * 用于确定性验证"构建与提交绑定"规则(真实 emcc 依赖本机工具链, 不可控)。
 */
export function makeStubCompiler() {
  return {
    async findEmcc() {
      return { ok: true, version: 'stub', path: 'stub' };
    },
    async compileDir(workId, srcDir) {
      const failed = fs.existsSync(path.join(srcDir, 'FAIL'));
      return failed ? { ok: false, log: 'stub build failure' } : { ok: true, log: 'stub build ok' };
    },
    TOOLCHAIN_HINT: '',
  };
}

/**
 * 测试工具 —— 启动一个进程内的测试服务器:
 *   - 随机端口, 独立临时数据目录(与开发数据完全隔离)
 *   - 启动后把真实 webhook 地址写回 app(git hook 需要它回调)
 *   - close() 关闭服务器并删除数据目录, 不残留任何后台进程
 */
export async function startServer(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cppp-test-'));
  // 默认本地模式(不依赖 Docker, 行为确定); 容器模式测试通过 options 覆盖
  const app = await createApp({ dataDir, port: 0, buildMode: 'local', ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  app.set('webhookUrl', `http://127.0.0.1:${port}/api/internal/publish`);

  const base = `http://127.0.0.1:${port}`;
  let token = '';

  return {
    base,
    dataDir,
    port,
    app, // 供测试访问 app.locals(构建队列/数据库等)
    /** 当前 token(供原始 fetch 使用) */
    get token() {
      return token;
    },
    /** 设置当前测试使用的创作者 token */
    setToken(t) {
      token = t;
    },
    /**
     * 封装的 fetch: 自动携带 token、序列化 JSON、校验期望状态码。
     * 传 form: FormData 时按 multipart 上传。
     */
    async api(pathname, { method = 'GET', body, form, expect = 200 } = {}) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(base + pathname, {
        method,
        headers,
        body: form || (body !== undefined ? JSON.stringify(body) : undefined),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status !== expect) {
        throw new Error(
          `请求 ${method} ${pathname} 期望状态 ${expect} 实际 ${res.status}: ${JSON.stringify(data)}`,
        );
      }
      return data;
    },
    /** 关闭服务器 + 销毁构建容器 + 释放 sqlite + 清理临时目录 */
    async close() {
      try {
        await app.locals.buildQueue?.stop();
      } catch {
        /* 忽略 */
      }
      try {
        app.locals.db?.close();
      } catch {
        /* 忽略 */
      }
      await new Promise((r) => server.close(r));
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

/**
 * 轮询直到 fn 返回真值(用于等待异步构建完成)。
 * 每次轮询先取最新状态再判断, 避免竞态。
 */
export async function poll(fn, { timeout = 60000, interval = 300, desc = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`轮询超时(60s): ${desc}${lastErr ? `, 最后错误: ${lastErr.message}` : ''}`);
}

/**
 * 登录辅助: 走完整注册流程 —— 注册(用户名+密码+邮箱) -> 开发模式验证 -> 登录。
 * 账号已存在时直接登录(注册 409 忽略)。返回登录响应。
 */
export async function login(srv, name, password = 'test-pass-1234') {
  const email = `${name}@test.local`;
  const reg = await srv
    .api('/api/auth/register', {
      method: 'POST',
      body: { username: name, password, email },
    })
    .catch(() => null); // 用户名已占用 -> 忽略, 直接登录
  if (reg) {
    // 开发模式(未配置 SMTP): 注册响应携带 verificationToken, 直接验证
    await srv.api('/api/auth/verify', { method: 'POST', body: { token: reg.verificationToken } });
  }
  const d = await srv.api('/api/auth/login', {
    method: 'POST',
    body: { account: name, password },
  });
  srv.setToken(d.token);
  return d;
}
