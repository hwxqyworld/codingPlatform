/**
 * 前端 API 封装 —— 与后端 REST 接口一一对应。
 * 统一处理: 携带 token、JSON 序列化、错误抛出。
 */

const TOKEN_KEY = 'cpp_platform_token';
const NAME_KEY = 'cpp_platform_creator';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function getCreatorName() {
  return localStorage.getItem(NAME_KEY) || '';
}
export function saveSession({ token, name }) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(NAME_KEY, name);
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
}

export class ApiError extends Error {}

/** 请求后端; 抛出的 ApiError.message 可直接展示给用户 */
async function request(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form; // FormData: 浏览器自动设置 multipart 边界
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok || data.ok === false) {
    throw new ApiError(data.error || `请求失败(${res.status})`);
  }
  return data;
}

export const api = {
  health: () => request('/api/health'),

  // —— 身份 ——
  login: (name) => request('/api/creator/login', { method: 'POST', body: { name } }),
  me: () => request('/api/me'),

  // —— 作品 ——
  homeWorks: () => request('/api/works'),
  allWorks: () => request('/api/works/all'),
  work: (id) => request(`/api/works/${id}`),
  createWork: (body) => request('/api/works', { method: 'POST', body }),
  updateWork: (id, body) => request(`/api/works/${id}`, { method: 'PUT', body }),
  deleteWork: (id) => request(`/api/works/${id}`, { method: 'DELETE' }),

  // —— 文件 ——
  files: (id) => request(`/api/works/${id}/files`),
  readFile: (id, p) => request(`/api/works/${id}/file?path=${encodeURIComponent(p)}`),
  saveFile: (id, p, content) =>
    request(`/api/works/${id}/file`, { method: 'PUT', body: { path: p, content } }),
  deleteFile: (id, p) =>
    request(`/api/works/${id}/file`, { method: 'DELETE', body: { path: p } }),
  moveFile: (id, from, to) =>
    request(`/api/works/${id}/file/move`, { method: 'POST', body: { from, to } }),
  upload: (id, file) => {
    const form = new FormData();
    form.append('file', file);
    return request(`/api/works/${id}/upload`, { method: 'POST', form });
  },

  // —— 提交 / 发布 / 构建 ——
  commit: (id, message) => request(`/api/works/${id}/commit`, { method: 'POST', body: { message } }),
  publish: (id) => request(`/api/works/${id}/publish`, { method: 'POST' }),
  build: (id) => request(`/api/works/${id}/build`, { method: 'POST' }),
  sync: (id) => request(`/api/works/${id}/sync`, { method: 'POST' }),
  history: (id, branch = 'main') => request(`/api/works/${id}/history?branch=${branch}`),
  gitInfo: (id) => request(`/api/works/${id}/git`),

  // —— 系统 ——
  toolchain: () => request('/api/toolchain'),
};

/** 相对时间格式化(主页/卡片展示用) */
export function fmtTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
