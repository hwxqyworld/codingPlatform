import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite 配置。
 * 开发模式下将 /api(平台接口)与 /w(作品运行产物)代理到后端,
 * 前端与后端完全同源, 无需处理跨域。
 * 生产模式下由后端同端口托管构建产物(见 server/src/routes.js)。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/w': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
