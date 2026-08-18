import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import multer from 'multer';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

/**
 * 路由层 —— 平台 REST API + git-over-HTTP + 作品运行产物静态托管 + 前端静态资源托管。
 *
 * 接口速览:
 *   GET    /api/health                        健康检查
 *   POST   /api/auth/register                 注册(用户名+密码+邮箱, 邮件验证)
 *   POST   /api/auth/verify                   邮箱验证(注册 / 换绑共用)
 *   POST   /api/auth/resend                   重发验证邮件(需用户名/邮箱+密码)
 *   POST   /api/auth/login                    登录(用户名或已验证邮箱 + 密码)
 *   POST   /api/auth/setup-password           早期免密账号升级(凭旧 token 设密码+绑邮箱)
 *   POST   /api/auth/password                 修改密码(成功后旧会话失效)
 *   POST   /api/auth/email                    换绑邮箱(发验证邮件到新邮箱)
 *   GET    /api/creators/:name                公开个人主页(资料 + 已发布作品)
 *   GET    /api/works                         主页作品流(近 30 天有更新, 无热度)
 *   GET    /api/works/all                     全部已发布作品
 *   GET    /api/works/:id                     作品详情(草稿仅本人可见)
 *   POST   /api/works                         创建作品(自动初始化 git 仓库 + 模板)
 *   PUT    /api/works/:id                     更新标题/简介
 *   DELETE /api/works/:id                     删除作品(含仓库)
 *   GET    /api/works/:id/files               文件树
 *   GET    /api/works/:id/file?path=          读取文件
 *   PUT    /api/works/:id/file                保存文件(写入 develop 工作区)
 *   DELETE /api/works/:id/file                删除文件
 *   POST   /api/works/:id/file/move           重命名/移动文件
 *   POST   /api/works/:id/upload              上传二进制资源(存入 assets/)
 *   POST   /api/works/:id/commit              提交到 develop 并推送
 *   POST   /api/works/:id/publish             发布: develop -> main(触发构建)
 *   POST   /api/works/:id/build               手动重新构建(兜底)
 *   POST   /api/works/:id/sync                同步工作区(拉取外部推送的 develop)
 *   GET    /api/works/:id/history             提交历史
 *   GET    /api/works/:id/git                 对外 git 远程地址与认证说明
 *   GET    /api/me                            我的账号信息 + 作品列表
 *   PUT    /api/me                            更新个人资料(昵称/简介/头像)
 *   POST   /api/internal/publish              内部 webhook(git hook 回调, 勿外调)
 *   GET|POST /git/:workId.git/*                git 智能 HTTP 协议(推送/拉取, Basic 认证)
 *   GET    /w/:workId/*                       作品运行产物(静态)
 */
export function registerRoutes(app, { cfg, db, git, auth, publisher, compiler, buildQueue, docker }) {
  const requireAuth = auth.middleware();
  const optionalAuth = auth.optionalMiddleware();
  const optionalBasicAuth = auth.optionalBasicAuth();

  /** 异步路由包装: 把抛出的异常统一交给错误中间件 */
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  /** 作品归属校验: 必须为创作者本人, 通过后 req.work 为作品对象 */
  const requireOwner = (req, res, next) => {
    const work = db.getWork(req.params.id);
    if (!work) return res.status(404).json({ ok: false, error: '作品不存在' });
    if (work.creator !== req.creator) {
      return res.status(403).json({ ok: false, error: '无权操作他人的作品' });
    }
    req.work = work;
    next();
  };

  /**
   * 简单固定窗口限流(内存): 认证类接口防暴力破解。
   * keyFn 默认取客户端 IP(trust proxy 开启时信任 X-Forwarded-For)。
   */
  function rateLimit({ limit, windowMs, keyFn = (req) => req.ip }) {
    const hits = new Map();
    return (req, res, next) => {
      const key = keyFn(req);
      const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.window !== windowStart) hits.delete(k);
      }
      const rec = hits.get(key);
      if (!rec || rec.window !== windowStart) {
        hits.set(key, { window: windowStart, count: 1 });
        return next();
      }
      rec.count += 1;
      if (rec.count > limit) {
        return res.status(429).json({ ok: false, error: '请求过于频繁, 请稍后再试' });
      }
      next();
    };
  }
  const authLimiter = rateLimit({ limit: cfg.authRateLimit, windowMs: cfg.authRateWindowMs });

  /** 加载作品模板文件(相对路径 -> 内容) */
  const loadTemplate = (name) => {
    const dir = path.join(cfg.templatesDir, name === 'sdl2' ? 'sdl2' : name);
    if (!fs.existsSync(path.join(dir, 'main.cpp'))) throw new AppError('未知的作品模板');
    const files = {};
    for (const f of fs.readdirSync(dir)) {
      if (fs.statSync(path.join(dir, f)).isFile()) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
    return files;
  };

  /** 上传文件名清洗: 去掉路径与非法字符 */
  const sanitize = (name) =>
    String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 120);

  /** 作品 ID 严格校验(git-over-HTTP 路径参数, 防路径穿越) */
  const WORK_ID_RE = /^w[0-9a-f]{8}$/;

  // ---------------- 基础 ----------------

  app.get('/api/health', (req, res) =>
    res.json({ ok: true, name: 'cpp-platform', time: Date.now() }),
  );

  /** 基础安全响应头 */
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  /** 构建工具链检测: 容器模式报告 Docker/镜像状态, 本地模式报告 emcc */
  app.get('/api/toolchain', wrap(async (req, res) => {
    if (cfg.buildMode === 'container') {
      let ok = false;
      let err = '';
      try {
        await docker.ping();
        ok = await docker.imageExists(cfg.buildImage);
      } catch (e) {
        err = e?.message || String(e);
      }
      res.json({
        ok,
        mode: 'container',
        version: cfg.buildImage,
        hint: ok
          ? null
          : `容器构建不可用: ${err || '缺少构建镜像'}\n构建镜像(需 Docker):\n  docker build -f server/docker/Dockerfile -t ${cfg.buildImage} .`,
      });
    } else {
      const info = await compiler.findEmcc();
      res.json({
        ok: info.ok,
        mode: 'local',
        version: info.version,
        path: info.path,
        hint: info.ok ? null : compiler.TOOLCHAIN_HINT,
      });
    }
  }));

  // ---------------- 账号系统 ----------------

  /** 注册: 用户名 + 密码 + 邮箱; 发送验证邮件(开发模式返回 verificationToken) */
  app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
    const r = await auth.register(req.body || {});
    res.json({ ok: true, ...r });
  }));

  /** 邮箱验证(注册验证 / 换绑邮箱共用) */
  app.post('/api/auth/verify', authLimiter, wrap(async (req, res) => {
    const r = auth.verifyEmail(String(req.body?.token || ''));
    res.json({ ok: true, ...r });
  }));

  /** 重发验证邮件: 需用户名/邮箱 + 密码(与登录同强度) */
  app.post('/api/auth/resend', authLimiter, wrap(async (req, res) => {
    const r = await auth.resendVerification(req.body || {});
    res.json({ ok: true, ...r });
  }));

  /** 登录: 用户名或已验证邮箱 + 密码; 早期免密账号返回 LEGACY_NEEDS_SETUP */
  app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
    const r = auth.login(req.body || {});
    res.json({ ok: true, ...r });
  }));

  /** 早期免密账号升级: 凭旧 token 设置密码(可选绑定邮箱) */
  app.post('/api/auth/setup-password', requireAuth, authLimiter, wrap(async (req, res) => {
    const r = await auth.setupPassword(req.creator, req.body || {});
    res.json({ ok: true, ...r });
  }));

  /** 修改密码: 校验当前密码, 成功后旧会话全部失效, 返回新 token */
  app.post('/api/auth/password', requireAuth, authLimiter, wrap(async (req, res) => {
    const r = auth.changePassword(req.creator, req.body || {});
    res.json({ ok: true, ...r });
  }));

  /** 换绑邮箱: 发验证邮件到新邮箱, 验证通过后替换 */
  app.post('/api/auth/email', requireAuth, authLimiter, wrap(async (req, res) => {
    const r = await auth.requestEmailChange(req.creator, req.body?.email);
    res.json({ ok: true, ...r });
  }));

  // ---------------- 个人主页 / 账号资料 ----------------

  /** 公开个人主页: 资料(不含邮箱等隐私) + 已发布作品 */
  app.get('/api/creators/:name', wrap(async (req, res) => {
    const user = db.getUser(req.params.name);
    if (!user) return res.status(404).json({ ok: false, error: '创作者不存在' });
    res.json({ ok: true, user: auth.publicUser(user), works: db.listPublishedByCreator(user.name) });
  }));

  /** 我的账号信息(含邮箱/验证状态) + 作品列表(含草稿) */
  app.get('/api/me', requireAuth, wrap(async (req, res) => {
    res.json({
      ok: true,
      creator: req.creator,
      user: auth.ownUser(req.user),
      works: db.listWorksByCreator(req.creator),
    });
  }));

  /** 更新个人资料(昵称/简介/头像) */
  app.put('/api/me', requireAuth, wrap(async (req, res) => {
    const { nickname, bio, avatar } = req.body || {};
    const patch = {};
    if (nickname !== undefined) {
      const n = String(nickname).trim().slice(0, 24);
      if (!n) throw new AppError('昵称不能为空');
      patch.nickname = n;
    }
    if (bio !== undefined) patch.bio = String(bio).trim().slice(0, 200);
    if (avatar !== undefined) {
      const a = String(avatar).trim();
      if (!a || a.length > 8 || /[\u0000-\u001f\u007f]/.test(a)) throw new AppError('头像格式不正确');
      patch.avatar = a;
    }
    db.updateProfile(req.creator, patch);
    res.json({ ok: true, user: auth.ownUser(db.getUser(req.creator)) });
  }));

  // ---------------- 作品浏览 ----------------

  /** 主页作品流: 最近 N 天内有更新的已发布作品, 按更新时间倒序。人人平等曝光, 无热度。 */
  app.get('/api/works', wrap(async (req, res) => {
    const since = Date.now() - cfg.homeWindowDays * 24 * 3600 * 1000;
    res.json({
      ok: true,
      windowDays: cfg.homeWindowDays,
      now: Date.now(),
      works: db.listPublishedSince(since),
    });
  }));

  /** 全部已发布作品(不分时间窗口) */
  app.get('/api/works/all', wrap(async (req, res) => {
    res.json({ ok: true, works: db.listPublished() });
  }));

  /**
   * 作品详情; 未发布(私有)且非本人时返回 404, 避免泄露草稿。
   * 附加 runSha: 实际运行的版本 —— main 最近一次提交构建成功则用它,
   * 否则回退到最近一次有效构建(平台规则: 显示最近一次有效构建)。
   */
  app.get('/api/works/:id', optionalAuth, wrap(async (req, res) => {
    const work = db.getWork(req.params.id);
    if (!work) return res.status(404).json({ ok: false, error: '作品不存在' });
    const isOwner = req.creator && work.creator === req.creator;
    if (!work.publishedSha && !isOwner) {
      return res.status(404).json({ ok: false, error: '作品尚未发布' });
    }
    const latest = db.latestBuild(work.id);
    const valid = db.latestValidBuild(work.id);
    const runSha = latest && latest.status === 'success' ? latest.sha : (valid ? valid.sha : null);
    const out = { ...work, isOwner, runSha };
    // 排队中: 附带队伍位置(前端展示"服务器繁忙, 正在队伍第 N 位"); 其余情况为 null
    out.queuePosition =
      out.buildStatus === 'queued' && buildQueue ? buildQueue.queuePositionOf(work.id) : null;
    res.json({ ok: true, work: out });
  }));

  // ---------------- 作品管理 ----------------

  /** 创建作品: 初始化 git 仓库(develop 工作区) + 写入模板 */
  app.post('/api/works', requireAuth, wrap(async (req, res) => {
    const { title, description = '', template = 'sdl2' } = req.body || {};
    if (!title || !String(title).trim()) throw new AppError('请填写作品标题');
    const id = 'w' + crypto.randomBytes(4).toString('hex');
    try {
      await git.initRepo(id, loadTemplate(template));
    } catch (err) {
      git.removeRepo(id); // 初始化失败时清理残留
      throw err;
    }
    const work = db.createWork({
      id,
      title: String(title).trim(),
      description: String(description).trim(),
      creator: req.creator,
    });
    res.json({ ok: true, work });
  }));

  app.put('/api/works/:id', requireAuth, requireOwner, wrap(async (req, res) => {
    const { title, description } = req.body || {};
    db.updateMeta(req.params.id, {
      title: title?.trim(),
      description: description?.trim(),
    });
    res.json({ ok: true, work: db.getWork(req.params.id) });
  }));

  app.delete('/api/works/:id', requireAuth, requireOwner, wrap(async (req, res) => {
    git.removeRepo(req.params.id);
    db.deleteWork(req.params.id);
    res.json({ ok: true });
  }));

  // ---------------- 文件操作(在线编辑器) ----------------

  /** 文件树: 已发布作品公开可读, 草稿仅本人 */
  const canReadFiles = (req, res, next) => {
    const work = db.getWork(req.params.id);
    if (!work) return res.status(404).json({ ok: false, error: '作品不存在' });
    const isOwner = req.creator && work.creator === req.creator;
    if (!work.publishedSha && !isOwner) {
      return res.status(403).json({ ok: false, error: '草稿仅创作者本人可见' });
    }
    req.work = work;
    next();
  };

  app.get('/api/works/:id/files', optionalAuth, canReadFiles, wrap(async (req, res) => {
    res.json({ ok: true, files: git.listFiles(req.params.id) });
  }));

  app.get('/api/works/:id/file', optionalAuth, canReadFiles, wrap(async (req, res) => {
    const rel = String(req.query.path || '');
    if (!rel) throw new AppError('缺少 path 参数');
    res.json({ ok: true, ...git.readFile(req.params.id, rel) });
  }));

  app.put('/api/works/:id/file', requireAuth, requireOwner, wrap(async (req, res) => {
    const { path: rel, content } = req.body || {};
    if (!rel || typeof content !== 'string') throw new AppError('缺少 path 或 content');
    git.writeFile(req.params.id, rel, content);
    res.json({ ok: true });
  }));

  app.delete('/api/works/:id/file', requireAuth, requireOwner, wrap(async (req, res) => {
    const rel = String(req.body?.path || '');
    if (!rel) throw new AppError('缺少 path 参数');
    git.deleteFile(req.params.id, rel);
    res.json({ ok: true });
  }));

  app.post('/api/works/:id/file/move', requireAuth, requireOwner, wrap(async (req, res) => {
    const { from, to } = req.body || {};
    if (!from || !to) throw new AppError('缺少 from 或 to');
    git.moveFile(req.params.id, from, to);
    res.json({ ok: true });
  }));

  /** 上传二进制资源(存入 assets/, 配合 compile.json 的 preload 使用) */
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, git.assetDir(req.params.id)),
      filename: (req, file, cb) => cb(null, sanitize(file.originalname)),
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
  });
  app.post('/api/works/:id/upload', requireAuth, requireOwner, upload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) throw new AppError('未收到文件');
      res.json({ ok: true, path: `assets/${req.file.filename}` });
    }));

  // ---------------- 提交 / 发布 / 构建 ----------------

  /** 提交全部改动到 develop 并推送(在线编辑器"提交") */
  app.post('/api/works/:id/commit', requireAuth, requireOwner, wrap(async (req, res) => {
    const sha = await git.commitDevelop(req.params.id, req.body?.message || '更新作品', req.creator);
    res.json({ ok: true, sha });
  }));

  /** 发布: develop -> main。main 被推送后触发平台构建(容器内 hook 无网络, 由平台直接触发)。 */
  app.post('/api/works/:id/publish', requireAuth, requireOwner, wrap(async (req, res) => {
    await git.publishDevelop(req.params.id);
    publisher.publish(req.params.id); // 异步执行; 与 hook 触发路径在 publisher 内去重
    res.json({ ok: true, message: '已推送到 main, 平台正在构建…' });
  }));

  /** 手动重新构建(hook 未触发时的兜底) */
  app.post('/api/works/:id/build', requireAuth, requireOwner, wrap(async (req, res) => {
    publisher.publish(req.params.id); // 异步执行, 由前端轮询构建状态
    res.json({ ok: true, message: '构建已开始' });
  }));

  /** 同步工作区(外部 git 推送 develop 后, 在线编辑器拉取最新) */
  app.post('/api/works/:id/sync', requireAuth, requireOwner, wrap(async (req, res) => {
    await git.syncWorktree(req.params.id);
    res.json({ ok: true });
  }));

  /** 提交历史(已发布作品公开; 草稿仅本人; 可指定 develop/main) */
  app.get('/api/works/:id/history', optionalAuth, wrap(async (req, res) => {
    const work = db.getWork(req.params.id);
    const isOwner = req.creator && work?.creator === req.creator;
    if (!work || (!work.publishedSha && !isOwner)) {
      return res.status(404).json({ ok: false, error: '作品不存在或尚未发布' });
    }
    const branch = req.query.branch === 'develop' ? 'develop' : 'main';
    // main 分支可能尚不存在(未发布过的草稿), 此时返回空历史而非报错
    let history = [];
    try {
      history = await git.history(req.params.id, branch);
    } catch {
      /* 分支不存在等场景 -> 空列表 */
    }
    res.json({ ok: true, history });
  }));

  /** 对外 git 远程地址(默认平台内置 git-over-HTTP)与认证说明 */
  app.get('/api/works/:id/git', requireAuth, requireOwner, wrap(async (req, res) => {
    res.json({
      ok: true,
      workId: req.params.id,
      remote: git.remoteUrl(req.params.id, req),
      publicUrl: cfg.publicUrl,
      auth: {
        username: req.creator,
        password: '账号密码或访问令牌(登录后由平台签发)',
      },
    });
  }));

  // ---------------- 内部 webhook ----------------

  /** git post-receive hook 回调: main 分支被推送 -> 触发发布流水线 */
  app.post('/api/internal/publish', wrap(async (req, res) => {
    if (cfg.webhookSecret && req.headers['x-webhook-secret'] !== cfg.webhookSecret) {
      return res.status(403).json({ ok: false, error: 'webhook 密钥不匹配' });
    }
    const { workId } = req.body || {};
    if (!workId || !db.getWork(workId)) {
      return res.status(404).json({ ok: false, error: '作品不存在' });
    }
    publisher.publish(workId); // 异步执行, hook 无需等待构建完成
    res.json({ ok: true });
  }));

  // ---------------- git 智能 HTTP 协议(git-over-HTTP) ----------------

  /**
   * 平台内置 git 远程通道: GET/POST /git/<workId>.git/<service>。
   * 由 git http-backend 提供智能协议, 平台负责鉴权与路径隔离:
   *   - 读取(upload-pack / info/refs): 已公开作品匿名可读, 草稿仅本人
   *   - 写入(receive-pack): 必须为作品创作者本人(Basic 认证)
   * 凭证: 用户名 = 创作者名称; 密码 = 账号密码 或 会话 token。
   * 推送走宿主机 receive-pack(与既有外部 push 设计一致), hook 照常触发构建。
   */
  function gitHttp(workId, subPath) {
    return wrap(async (req, res) => {
      if (!WORK_ID_RE.test(workId)) throw new AppError('作品 ID 不合法', 400);
      const work = db.getWork(workId);
      if (!work) return res.status(404).json({ ok: false, error: '作品不存在' });

      const isWrite =
        subPath === '/git-receive-pack' || (subPath === '/info/refs' && req.query.service === 'git-receive-pack');
      const isOwner = req.creator && req.creator === work.creator;
      if (isWrite) {
        if (!isOwner) {
          res.setHeader('WWW-Authenticate', 'Basic realm="cpp-platform"');
          return res.status(401).json({ ok: false, error: '请使用作品创作者的账号认证后再推送' });
        }
      } else {
        const isPublic = work.publishedSha && db.hasValidBuild(work.id);
        if (!isPublic && !isOwner) {
          res.setHeader('WWW-Authenticate', 'Basic realm="cpp-platform"');
          return res.status(401).json({ ok: false, error: '作品未公开, 仅创作者本人可访问' });
        }
      }

      // 交由 git http-backend 处理智能协议
      const query = req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '';
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: cfg.reposDir,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: `/${workId}.git${subPath}`,
          QUERY_STRING: query,
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers['content-type'] || '',
          CONTENT_LENGTH: req.headers['content-length'] || '0',
          REMOTE_USER: req.creator || '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let headerBuf = Buffer.alloc(0);
      let headersDone = false;
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        console.error('[git-http] 无法启动 git http-backend:', err.message);
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'git 服务不可用' });
      });
      child.on('close', () => {
        if (stderr.trim()) console.error('[git-http]', stderr.trim().slice(0, 2000));
        if (!headersDone && !res.headersSent) {
          res.status(502).json({ ok: false, error: 'git 处理失败' });
          return;
        }
        if (!res.writableEnded) res.end();
      });
      // 解析 http-backend 输出的 "Status 行 + 响应头 + 响应体", 边解析边转发
      child.stdout.on('data', (chunk) => {
        if (!headersDone) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const crlf = headerBuf.indexOf('\r\n\r\n');
          const lf = crlf === -1 ? headerBuf.indexOf('\n\n') : -1;
          const end = crlf !== -1 ? crlf : lf;
          if (end === -1) return; // 头部未收完, 继续累积
          const head = headerBuf.slice(0, end).toString('utf8');
          const rest = headerBuf.slice(end + (crlf !== -1 ? 4 : 2));
          let statusCode = 200;
          for (const line of head.split(/\r?\n/)) {
            const m = line.match(/^Status:\s*(\d+)/i);
            if (m) {
              statusCode = Number(m[1]);
              continue;
            }
            const i = line.indexOf(':');
            if (i === -1) continue;
            const key = line.slice(0, i).trim();
            const val = line.slice(i + 1).trim();
            if (/^(transfer-encoding|connection|keep-alive|upgrade|status)$/i.test(key)) continue; // Node 自行管理
            try {
              res.setHeader(key, val);
            } catch {
              /* 忽略非法响应头 */
            }
          }
          res.statusCode = statusCode;
          headersDone = true;
          if (rest.length) res.write(rest);
          return;
        }
        res.write(chunk);
      });

      req.pipe(child.stdin); // 请求体(推送的 pack 数据)直通 backend
      req.on('error', () => {
        child.kill();
      });
    });
  }

  app.all('/git/:workId.git/*', optionalBasicAuth, (req, res, next) => {
    const idx = req.path.indexOf('.git');
    const subPath = idx === -1 ? '' : req.path.slice(idx + 4);
    return gitHttp(req.params.workId, subPath)(req, res, next);
  });
  // 仓库根路径(不带子路径)重定向到 info/refs, 兼容裸 URL 访问
  app.get('/git/:workId.git', optionalBasicAuth, (req, res) =>
    res.redirect(302, `/git/${req.params.workId}.git/info/refs?service=git-upload-pack`));

  // ---------------- 作品运行产物静态托管 ----------------

  app.use('/w/:workId', (req, res, next) => {
    const dir = path.join(cfg.artifactsDir, req.params.workId, 'current');
    if (!fs.existsSync(path.join(dir, 'index.html'))) {
      return res
        .status(404)
        .type('html')
        .send('<h3>该作品尚未构建成功</h3><p>请先发布(推送 main 分支)完成构建后再来游玩。</p>');
    }
    express.static(dir, {
      index: 'index.html',
      followSymlinks: false, // 防符号链接(产物落盘前已清理, 双保险)
      setHeaders: (r) => r.setHeader('Cache-Control', 'no-store'), // 构建产物随时可能更新
    })(req, res, next);
  });

  // ---------------- 前端静态资源(生产模式) ----------------

  const distDir = cfg.webDistDir;
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPA 回退: 前端路由交给 index.html; 未匹配的 API / 产物路径返回 JSON 404
    // (注意用带斜杠的前缀, 避免误伤 /work/... 等前端路由)
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/w/') || req.path.startsWith('/git/')) {
        return res.status(404).json({ ok: false, error: '接口不存在' });
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    // 开发模式: 前端由 Vite 开发服务器提供(见 web/vite.config.js 的代理)
    app.use((req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));
  }

  // ---------------- 统一错误处理 ----------------

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res
        .status(err.status)
        .json({ ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    if (err?.mail) {
      return res.status(502).json({ ok: false, error: err.message });
    }
    if (err?.name === 'MulterError') {
      return res.status(400).json({ ok: false, error: `上传失败: ${err.message}` });
    }
    if (err?.type && err.type.startsWith('entity.')) {
      return res.status(400).json({ ok: false, error: '请求体格式错误' });
    }
    console.error('[error]', err);
    res.status(500).json({ ok: false, error: '服务器内部错误' });
  });
}
