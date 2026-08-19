/**
 * Next.js 配置。
 *
 * 架构: 后端 Express 是唯一对外入口(PORT 3000):
 *   - /api /w /git 由 Express 直连处理(不变)
 *   - 其余页面请求由 Express 反向代理到本服务(内部 3010)
 * 因此本服务只面向内网/回环, 生产用 standalone 输出(server.js),
 * 由 server/src/start-all.js 拉起; 开发模式 next dev -p 3010。
 *
 * Monaco 编辑器: 不经过 webpack 打包(体积大且触发 V8 崩溃),
 * 由 scripts/copy-monaco.mjs 把 min/vs 复制到 public/monaco/vs 静态托管,
 * 运行时经 loader.config 加载 —— 详见 components/editor/MonacoWrap.tsx。
 */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
