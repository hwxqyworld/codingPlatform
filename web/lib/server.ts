/**
 * 服务端数据获取 —— 仅供 Server Components / Route Handlers 使用。
 * 通过 Express 入口(3000)回环访问后端, 与浏览器同源语义一致;
 * 所有读取强制 no-store(平台数据持续变化: 构建完成、新作品发布)。
 */
import { API_BASE } from './env';
import { ApiError } from './api';

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  let data: { ok?: boolean; error?: string } & Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok || data.ok === false) {
    throw new ApiError(data.error || `请求失败(${res.status})`);
  }
  return data as T;
}
