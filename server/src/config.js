import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 平台配置中心。
 *
 * 所有路径默认落在 server/data/ 下, 可通过环境变量或 createApp 的 options 覆盖
 * (测试时即通过 options 注入独立的临时数据目录, 互不干扰)。
 *
 * 可用环境变量:
 *   PORT              服务端口(默认 3000)
 *   HOST              监听地址(默认 0.0.0.0)
 *   DATA_DIR          数据目录(默认 server/data)
 *   PUBLIC_URL        对外访问地址(默认 http://127.0.0.1:PORT)
 *   GIT_BASE_URL      对外 git 远程地址前缀(默认空 = 使用本机文件路径)
 *   CORS_ORIGINS      跨域允许的 Origin 白名单, 逗号分隔(默认 https://coding.xqyworld.cn)
 *   HOME_WINDOW_DAYS  主页收录窗口, 最近 N 天有更新(默认 30)
 *   BUILD_TIMEOUT_MS  单次构建超时(默认 5 分钟)
 *   EMCC              emcc 可执行文件路径(默认自动探测, 无需 .bat/.exe 后缀)
 *   EMSDK             emsdk 安装目录(自动探测 $EMSDK/upstream/emscripten/emcc)
 *   WEBHOOK_SECRET    内部 webhook 校验密钥(可选)
 *
 * —— 账号系统 ——
 *   ALLOW_REGISTRATION 是否开放注册(默认 true; 设为 false 关闭公开注册)
 *   MIN_PASSWORD_LEN    密码最小长度(默认 8)
 *   VERIFY_TOKEN_TTL_MS 邮箱验证令牌有效期(默认 24 小时)
 *   AUTH_RATE_LIMIT     认证接口每 IP 窗口内最大请求数(默认 30)
 *   AUTH_RATE_WINDOW_MS 认证限流窗口(默认 60 秒)
 *
 * —— 邮件(邮箱验证 / 换绑) ——
 *   未配置 SMTP 时进入开发模式: 验证链接打印到服务端控制台,
 *   注册接口同时返回 verificationToken(仅限开发模式, 便于测试与本地体验)。
 *   SMTP_HOST    SMTP 服务器地址(配置后即启用真实邮件发送)
 *   SMTP_PORT    SMTP 端口(默认 587)
 *   SMTP_SECURE  是否使用 SMTPS(SSL/TLS, 465 端口时设 1; 默认 0 = STARTTLS)
 *   SMTP_USER    SMTP 用户名(可为空 = 匿名发送)
 *   SMTP_PASS    SMTP 密码
 *   MAIL_FROM    发件人地址(默认 noreply@localhost)
 *
 * —— 容器构建(安全模式) ——
 *   BUILD_MODE          auto | local | container(默认 auto)
 *                        auto: Docker 可用且镜像存在 → container, 否则 local
 *                        local: 宿主机 emcc 直接编译(开发/降级)
 *                        container: 强制容器构建(Docker 不可用时构建报错)
 *   BUILD_IMAGE         构建容器镜像名(默认 cppplay-builder:latest)
 *   BUILD_TIMEOUT_MS    单次构建超时(默认 60 秒)
 *   BUILD_WORKER_CPUS   构建容器 CPU 上限(默认 1 核)
 *   BUILD_WORKER_MEM_MB 构建容器内存上限(默认 2GB)
 *   BUILD_POOL_MIN      构建容器池下限/热备数(默认 1)
 *   BUILD_POOL_MAX      构建容器池上限(默认 3)
 *   BUILD_SCALE_UP_QUEUE 排队任务超过该数触发扩容(默认 5)
 *   BUILD_SCALE_DOWN_MS  队空持续该时长触发缩容(默认 300 秒)
 *   DOCKER_HOST          Docker 引擎地址(默认自动: Linux unix socket
 *                        /var/run/docker.sock, Windows 命名管道, 支持 tcp://)
 */
export function resolveConfig(overrides = {}) {
  const env = process.env;
  const port = Number(env.PORT || overrides.port || 3000);
  const dataDir = path.resolve(env.DATA_DIR || overrides.dataDir || path.join(__dirname, '..', 'data'));

  return {
    port,
    host: env.HOST || '0.0.0.0',

    // —— 数据目录结构 ——
    dataDir,
    reposDir: path.join(dataDir, 'repos'),        // 裸仓库(接收 git push)
    worktreesDir: path.join(dataDir, 'worktrees'), // develop 工作区(在线编辑器读写)
    artifactsDir: path.join(dataDir, 'artifacts'), // 编译产物(供 /w/<id>/ 静态托管)
    dbFile: path.join(dataDir, 'platform.db'),

    // —— 对外地址 ——
    publicUrl: env.PUBLIC_URL || `http://127.0.0.1:${port}`,
    gitBaseUrl: env.GIT_BASE_URL || '',

    // —— 跨域(CORS)白名单 ——
    // 仅允许列出的 Origin 跨域访问 API; 可经 CORS_ORIGINS 追加(逗号分隔)
    corsOrigins: (env.CORS_ORIGINS || 'https://coding.xqyworld.cn')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    // —— 前端(Next.js) ——
    // Express 是唯一对外入口, 页面请求反向代理到内部 Next 服务(开发: next dev;
    // 生产: standalone server.js, 由 start-all.js 拉起)
    nextInternalUrl: env.NEXT_INTERNAL_URL || 'http://127.0.0.1:3010',

    // —— 主页规则 ——
    homeWindowDays: Number(env.HOME_WINDOW_DAYS || overrides.homeWindowDays || 30),

    // —— 构建 ——
    buildMode: env.BUILD_MODE || overrides.buildMode || 'auto', // auto | local | container
    buildImage: env.BUILD_IMAGE || overrides.buildImage || 'cppplay-builder:latest',
    buildTimeoutMs: Number(env.BUILD_TIMEOUT_MS || overrides.buildTimeoutMs || 60 * 1000), // 单次构建超时(默认 60 秒)
    emcc: env.EMCC || 'emcc',
    maxBuildLogBytes: 200 * 1024,

    // —— 构建容器池(规格: 1 核 / 2GB, 热备 1 个, 上限 3 个) ——
    workerCpus: Number(env.BUILD_WORKER_CPUS || overrides.workerCpus || 1),
    workerMemoryMb: Number(env.BUILD_WORKER_MEM_MB || overrides.workerMemoryMb || 2048),
    workerPidsLimit: Number(env.BUILD_WORKER_PIDS || overrides.workerPidsLimit || 256),
    poolMin: Number(env.BUILD_POOL_MIN || overrides.poolMin || 1),
    poolMax: Number(env.BUILD_POOL_MAX || overrides.poolMax || 3),
    scaleUpQueueLen: Number(env.BUILD_SCALE_UP_QUEUE || overrides.scaleUpQueueLen || 5), // 排队超过 5 个任务触发扩容
    scaleDownIdleMs: Number(env.BUILD_SCALE_DOWN_MS || overrides.scaleDownIdleMs || 300 * 1000), // 队空 300s 触发缩容
    gitMemoryMb: Number(env.GIT_OP_MEM_MB || overrides.gitMemoryMb || 512), // 一次性 git 操作容器内存上限

    // —— 内部 webhook(由 git post-receive hook 回调) ——
    webhookSecret: env.WEBHOOK_SECRET || '',

    // —— 账号系统 ——
    allowRegistration: (env.ALLOW_REGISTRATION ?? 'true') !== 'false',
    minPasswordLen: Number(env.MIN_PASSWORD_LEN || 8),
    verifyTokenTtlMs: Number(env.VERIFY_TOKEN_TTL_MS || 24 * 3600 * 1000),
    authRateLimit: Number(env.AUTH_RATE_LIMIT || 30), // 每 IP 每窗口最大认证请求数
    authRateWindowMs: Number(env.AUTH_RATE_WINDOW_MS || 60 * 1000),

    // —— 邮件(SMTP) ——
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === '1' || env.SMTP_SECURE === 'true',
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || 'noreply@localhost',
    },

    // —— 反向代理(nginx 等): 设为 1/loopback 后, req.protocol 信任 X-Forwarded-Proto ——
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true' || env.TRUST_PROXY === 'loopback' ? env.TRUST_PROXY : false,
  };
}
