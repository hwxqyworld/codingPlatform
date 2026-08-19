import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.js';
import { createDb } from './db.js';
import { createGitService } from './git.js';
import { createCompiler } from './compile.js';
import { createPublisher } from './publisher.js';
import { createBuildQueue } from './buildQueue.js';
import { createDockerClient } from './dockerClient.js';
import { createAuth } from './auth.js';
import { createMailer } from './mailer.js';
import { registerRoutes } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 应用工厂 —— 组装配置、数据库、git 服务、容器池/队列、编译服务、发布流水线、路由。
 *
 * 依赖注入设计: createApp(options) 可传入覆盖配置(如测试用的临时数据目录、
 * 随机端口、假编译器、假 docker 客户端), 因此测试可以完全隔离地启动多个实例。
 *
 * 构建模式(auto | local | container):
 *   - auto:      Docker 可达且镜像存在 → container, 否则 local
 *   - container: 平台侧 git 与构建全部在容器内执行(安全模式)
 *   - local:     宿主机 emcc 直接编译(开发/降级)
 */
export async function createApp(options = {}) {
  const cfg = resolveConfig(options);
  // 随代码分发的静态资源(与数据目录无关)
  cfg.templatesDir = path.join(__dirname, 'templates');
  cfg.shellFile = path.join(__dirname, 'shell.html');
  cfg.webDistDir = options.webDistDir || path.join(__dirname, '..', '..', 'web', 'dist');
  cfg.nextStandaloneDir =
    options.nextStandaloneDir || path.join(__dirname, '..', '..', 'web', '.next', 'standalone');

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy); // 反向代理场景下取真实协议/IP
  app.use(express.json({ limit: '4mb' }));

  // —— CORS ——
  // 仅允许白名单内的 Origin 跨域访问(cfg.corsOrigins, 默认 https://coding.xqyworld.cn)。
  // 同源请求(本机 3000 直接访问 /api)不携带跨域 Origin, 不受影响。
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && cfg.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') return res.sendStatus(204); // 预检请求直接放行
    }
    next();
  });

  // git hook 需要回调平台的 webhook 地址; 服务器实际端口在 listen 之后才确定,
  // 因此这里用"惰性读取"的方式, 由 index.js / 测试在启动后 app.set('webhookUrl', ...)。
  const getWebhookUrl = () =>
    app.get('webhookUrl') || `http://127.0.0.1:${cfg.port}/api/internal/publish`;

  const db = createDb(cfg);
  sweepStaleStaging(cfg.artifactsDir); // 清理上次进程异常退出残留的临时产物目录

  // —— 容器模式装配 ——
  const docker = options.docker || createDockerClient();
  cfg.buildMode = await resolveBuildMode(cfg, docker);
  if (cfg.buildMode === 'container') {
    console.log(`[build] 容器构建模式: 镜像 ${cfg.buildImage}, 池 ${cfg.poolMin}~${cfg.poolMax} 个(1 核/2GB), 构建超时 ${Math.round(cfg.buildTimeoutMs / 1000)}s`);
  } else {
    console.log('[build] 本地构建模式: 宿主机 emcc(未检测到 Docker 或镜像缺失时自动降级)');
  }

  const git = createGitService(cfg, { getWebhookUrl, docker, mode: cfg.buildMode });
  // 测试可注入假编译器(createApp options.compiler), 以确定性验证"构建与提交绑定"规则
  const compiler = options.compiler || createCompiler(cfg);

  let buildQueue = null;
  if (cfg.buildMode === 'container') {
    buildQueue = options.buildQueue || createBuildQueue({ cfg, db, git, docker });
    await buildQueue.start(); // 拉起后台热备容器
  }
  const publisher = createPublisher({ cfg, db, git, compiler, buildQueue });
  const mailer = createMailer(cfg);
  const auth = createAuth(cfg, db, mailer);

  // 挂到 app 上, 便于退出时释放资源(关闭 sqlite 连接 / 销毁构建容器)
  app.locals.db = db;
  app.locals.buildQueue = buildQueue;

  registerRoutes(app, { cfg, db, git, auth, publisher, compiler, buildQueue, docker });

  // 启动恢复: 上次进程退出时处于"排队中/构建中"的作品重新入队
  // (构建队列在内存中, 进程重启即丢失; 恢复后重新构建, 避免状态永久卡死)
  for (const w of db.listInterrupted()) {
    console.log(`[build] 恢复中断的构建: ${w.id}(${w.buildStatus})`);
    publisher.publish(w.id);
  }

  return app;
}

/**
 * 清理 artifacts 下残留的 .staging-* 临时产物目录。
 * 上次进程异常退出时, 构建任务的宿主临时目录可能未及清理(未持久化, 可能含恶意内容)。
 * 正式产物 current 不受影响。
 */
function sweepStaleStaging(artifactsDir) {
  if (!fs.existsSync(artifactsDir)) return;
  for (const workId of fs.readdirSync(artifactsDir)) {
    const dir = path.join(artifactsDir, workId);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const ent of fs.readdirSync(dir)) {
      if (!ent.startsWith('.staging-')) continue;
      const abs = path.join(dir, ent);
      try {
        fs.rmSync(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* 尽力而为 */
      }
    }
  }
}

/** 解析构建模式: auto → 探测 Docker 与镜像, 其余按配置直取 */
async function resolveBuildMode(cfg, docker) {
  if (cfg.buildMode === 'container' || cfg.buildMode === 'local') return cfg.buildMode;
  try {
    await docker.ping();
    if (await docker.imageExists(cfg.buildImage)) return 'container';
    console.log('[build] Docker 可达但缺少构建镜像, 回退本地模式; 构建镜像: docker build -f server/docker/Dockerfile -t cppplay-builder .');
  } catch (err) {
    console.log('[build] Docker 不可用, 回退本地模式:', err?.message || err);
  }
  return 'local';
}
