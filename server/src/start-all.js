import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 生产启动器 —— 单进程拉起前后端:
 *   1. 启动 Next.js standalone 服务(内部端口 3010, 提供页面与静态资源)
 *   2. 启动 Express 主服务(PORT 3000, 对外入口; /api /w /git 直连, 页面反代到 Next)
 *
 * 本地开发请用两个终端: cd server && npm start(3000) + cd web && npm run dev(3010)。
 *
 * 用法: node server/src/start-all.js
 */
const standaloneDir = path.join(__dirname, '..', '..', 'web', '.next', 'standalone');
const serverJs = path.join(standaloneDir, 'server.js');
const nextPort = process.env.NEXT_INTERNAL_PORT || '3010';

/** 轮询等待端口可连接(Next 启动就绪) */
function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(Number(port), '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`等待 Next 服务(${port})超时`));
        else setTimeout(tryConnect, 300);
      });
    };
    tryConnect();
  });
}

const hasStandalone = fs.existsSync(serverJs);

if (hasStandalone) {
  console.log(`[next] 启动 standalone 服务(端口 ${nextPort})…`);
  const child = spawn(process.execPath, [serverJs], {
    cwd: standaloneDir,
    env: { ...process.env, PORT: nextPort, HOSTNAME: '0.0.0.0', NODE_ENV: 'production' },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    console.error(`[next] standalone 退出(code=${code}, signal=${signal})`);
    process.exit(code ?? 1);
  });

  // Express 关闭/退出前先回收 Next 子进程
  const killNext = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
  };
  process.on('SIGINT', killNext);
  process.on('SIGTERM', killNext);

  await waitForPort(nextPort).catch((err) => {
    console.error('[next]', err.message);
    process.exit(1);
  });
  console.log(`[next] standalone 就绪: http://127.0.0.1:${nextPort}`);
} else {
  console.warn(
    `[next] 未找到 ${serverJs} —— 跳过 Next 启动。\n` +
      '  开发模式请另开终端: cd web && npm run dev(3010 端口)\n' +
      '  生产模式请先构建:   cd web && npm run build',
  );
}

// 启动 Express 主服务(注册 SIGINT/SIGTERM 优雅退出)
await import('./index.js');
