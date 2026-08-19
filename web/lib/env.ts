/**
 * 环境判定: next build / standalone 生产运行时 NODE_ENV === 'production';
 * next dev / 测试 NODE_ENV === 'development' | 'test'。
 */
const isProd = process.env.NODE_ENV === 'production';

/** 对外访问地址(与后端 PUBLIC_URL 一致); 用于生成 canonical / OG 链接 */
export const PUBLIC_URL = (
  process.env.PUBLIC_URL || (isProd ? 'https://coding.xqyworld.cn' : 'http://127.0.0.1:3000')
).replace(/\/$/, '');

/** 服务端组件访问后端 API 的基址(经 Express 入口回环, 保持与浏览器同源语义) */
export const API_BASE = (
  process.env.INTERNAL_API_URL ||
  process.env.PUBLIC_URL ||
  (isProd ? 'https://coding-api.xqyworld.cn' : 'http://127.0.0.1:3000')
).replace(/\/$/, '');
