/**
 * 环境判定: next build / standalone 生产运行时 NODE_ENV === 'production';
 * next dev / 测试 NODE_ENV === 'development' | 'test'。
 */
const isProd = process.env.NODE_ENV === 'production';

/** 对外访问地址(与后端 PUBLIC_URL 一致); 用于生成 canonical / OG 链接 */
export const PUBLIC_URL = (
  process.env.PUBLIC_URL || (isProd ? 'https://coding.xqyworld.cn' : 'http://127.0.0.1:3000')
).replace(/\/$/, '');

/**
 * 服务端组件访问后端 API 的基址。
 *
 * 必须始终指向与 Next 同进程/同容器的 Express 回环地址(127.0.0.1:3000),
 * 不能使用 PUBLIC_URL(那是浏览器访问的对外地址, 容器内不可达):
 *   - PUBLIC_URL 设为域名/局域网 IP 时, 容器内 SSR 请求该地址会打出去或打回自己,
 *     造成 /api 404/连接失败 —— 与浏览器同源语义完全不符。
 *   - docker run 未设 PUBLIC_URL 时, 旧实现回退到写死的公网域名
 *     (coding-api.xqyworld.cn), SSR 数据请求同样 404。
 * 仅在确有独立 API 网关/反向代理时, 用 INTERNAL_API_URL 覆盖。
 */
export const API_BASE = (process.env.INTERNAL_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
