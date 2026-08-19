/**
 * 客户端 API 封装 —— 与后端 REST 接口一一对应。
 * 统一处理: 携带 token(localStorage)、JSON 序列化、错误抛出。
 * 仅供 Client Components 使用; Server Components 用 lib/server.ts。
 */

import type {
  ContentResponse,
  CreatorResponse,
  FilesResponse,
  GitInfo,
  HistoryResponse,
  HomeWorksResponse,
  LoginResponse,
  MeResponse,
  RegisterResponse,
  ToolchainInfo,
  VerifyResponse,
  Work,
  WorkDetailResponse,
} from './types';

const TOKEN_KEY = 'cpp_platform_token';
const NAME_KEY = 'cpp_platform_creator';

export function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function getCreatorName(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(NAME_KEY) || '';
}

export function saveSession({ token, name }: { token: string; name: string }): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(NAME_KEY, name);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
}

export class ApiError extends Error {}

interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
}

/** 请求后端; 抛出的 ApiError.message 可直接展示给用户 */
async function request<T>(path: string, { method = 'GET', body, form }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (form) {
    payload = form; // FormData: 浏览器自动设置 multipart 边界
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
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

export const api = {
  // —— 身份 ——
  login: (account: string, password: string) =>
    request<LoginResponse>('/api/auth/login', { method: 'POST', body: { account, password } }),
  register: (username: string, password: string, email: string) =>
    request<RegisterResponse>('/api/auth/register', { method: 'POST', body: { username, password, email } }),
  verify: (token: string) =>
    request<VerifyResponse>('/api/auth/verify', { method: 'POST', body: { token } }),
  resend: (account: string, password: string) =>
    request<RegisterResponse>('/api/auth/resend', { method: 'POST', body: { account, password } }),
  me: () => request<MeResponse>('/api/me'),
  updateProfile: (patch: { nickname?: string; bio?: string; avatar?: string }) =>
    request<{ ok: true }>('/api/me', { method: 'PUT', body: patch }),
  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: true; token?: string }>('/api/auth/password', {
      method: 'POST',
      body: { oldPassword, newPassword },
    }),

  // —— 作品 ——
  homeWorks: () => request<HomeWorksResponse>('/api/works'),
  allWorks: () => request<{ ok: true; works: Work[] }>('/api/works/all'),
  work: (id: string) => request<WorkDetailResponse>(`/api/works/${id}`),
  creator: (name: string) => request<CreatorResponse>(`/api/creators/${encodeURIComponent(name)}`),
  createWork: (body: { title: string; description?: string }) =>
    request<{ ok: true; work: Work }>('/api/works', { method: 'POST', body }),
  updateWork: (id: string, body: { title?: string; description?: string }) =>
    request<{ ok: true; work: Work }>(`/api/works/${id}`, { method: 'PUT', body }),
  deleteWork: (id: string) => request<{ ok: true }>(`/api/works/${id}`, { method: 'DELETE' }),

  // —— 文件 ——
  files: (id: string) => request<FilesResponse>(`/api/works/${id}/files`),
  readFile: (id: string, p: string) =>
    request<ContentResponse>(`/api/works/${id}/file?path=${encodeURIComponent(p)}`),
  saveFile: (id: string, p: string, content: string) =>
    request<{ ok: true }>(`/api/works/${id}/file`, { method: 'PUT', body: { path: p, content } }),
  deleteFile: (id: string, p: string) =>
    request<{ ok: true }>(`/api/works/${id}/file`, { method: 'DELETE', body: { path: p } }),
  moveFile: (id: string, from: string, to: string) =>
    request<{ ok: true }>(`/api/works/${id}/file/move`, { method: 'POST', body: { from, to } }),
  upload: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ ok: true; path: string }>(`/api/works/${id}/upload`, { method: 'POST', form });
  },

  // —— 提交 / 发布 / 构建 ——
  commit: (id: string, message: string) =>
    request<{ ok: true; sha: string }>(`/api/works/${id}/commit`, { method: 'POST', body: { message } }),
  publish: (id: string) => request<{ ok: true }>(`/api/works/${id}/publish`, { method: 'POST' }),
  build: (id: string) => request<{ ok: true }>(`/api/works/${id}/build`, { method: 'POST' }),
  sync: (id: string) => request<{ ok: true }>(`/api/works/${id}/sync`, { method: 'POST' }),
  history: (id: string, branch = 'main') =>
    request<HistoryResponse>(`/api/works/${id}/history?branch=${branch}`),
  gitInfo: (id: string) => request<{ ok: true } & GitInfo>(`/api/works/${id}/git`),

  // —— 系统 ——
  toolchain: () => request<{ ok: true } & ToolchainInfo>('/api/toolchain'),
};
