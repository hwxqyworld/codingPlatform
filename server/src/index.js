import fs from 'node:fs';
import { createApp } from './app.js';
import { resolveConfig } from './config.js';

/**
 * 服务入口。
 *
 * 启动流程:
 *   1. 解析配置(环境变量可覆盖)
 *   2. 创建应用(容器模式: 探测 Docker/镜像, 拉起热备构建容器)并监听端口
 *   3. 监听成功后把真实地址写回 app, 供 git post-receive hook 回调
 *   4. 注册 SIGINT / SIGTERM 优雅退出(关闭服务器 + 释放 sqlite + 销毁构建容器)
 */
const cfg = resolveConfig();
const app = await createApp(cfg);

const server = app.listen(cfg.port, cfg.host, () => {
  app.set('webhookUrl', `http://127.0.0.1:${server.address().port}/api/internal/publish`);
  console.log('==============================================');
  console.log('  C++ 编程平台后端已启动');
  console.log(`  接口地址:   http://127.0.0.1:${server.address().port}`);
  console.log(`  数据目录:   ${cfg.dataDir}`);
  console.log(`  构建模式:   ${cfg.buildMode === 'container' ? '容器(安全模式)' : '本地 emcc(降级)'}`);
  console.log(`  主页窗口:   最近 ${cfg.homeWindowDays} 天有更新(推送 main 即算一次更新)`);
  console.log(`  邮件服务:   ${cfg.smtp.host ? `SMTP(${cfg.smtp.host}:${cfg.smtp.port})` : '开发模式(验证链接打印到控制台)'}`);
  console.log(`  前端页面:   ${fs.existsSync(cfg.webDistDir) ? '已构建(同端口访问)' : '开发模式(Vite 5173 端口)'}`);
  console.log('==============================================');
});

/** 优雅退出: 关闭服务器、销毁构建容器、关闭数据库, 不残留后台进程 */
function shutdown() {
  console.log('\n正在关闭…');
  Promise.allSettled([
    app.locals.buildQueue ? app.locals.buildQueue.stop() : Promise.resolve(),
  ]).finally(() => {
    try {
      app.locals.db?.close();
    } catch {
      /* 忽略关闭异常 */
    }
    server.close(() => process.exit(0));
  });
  // 兜底: 3 秒内未能关闭则强制退出
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
