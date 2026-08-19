import { createProxyMiddleware } from 'http-proxy-middleware';

/**
 * 页面请求反向代理 —— 把非 /api /w /git 的请求转发给内部 Next.js 服务。
 *
 * 开发模式: next dev -p 3010(支持 HMR websocket)
 * 生产模式: standalone server.js(PORT=3010, 由 start-all.js 拉起)
 *
 * Next 未启动时返回可读的 503 页, 而不是让连接悬挂。
 */
export function createWebProxy(nextInternalUrl) {
  return createProxyMiddleware({
    target: nextInternalUrl,
    changeOrigin: false, // 保持原始 Host, Next 据此生成内部跳转地址
    ws: true, // 开发模式 HMR websocket
    xfwd: true, // 透传 X-Forwarded-* (Next 日志/规范)
    on: {
      error: (err, req, res) => {
        if (res.headersSent || res.writableEnded) return;
        res
          .status(503)
          .type('html')
          .send(
            '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>前端服务未就绪</title>' +
              '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0b1120;color:#e6ecf7">' +
              `<div style="text-align:center"><h1>前端服务未就绪</h1><p>Next.js 服务(${nextInternalUrl})暂不可用, 请稍后刷新。</p></div>`,
          );
      },
    },
  });
}
