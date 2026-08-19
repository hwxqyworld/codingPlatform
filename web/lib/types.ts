/** 与后端 REST API 响应对应的共享类型(见 server/src/routes.js 与 db.js) */

export type BuildStatus = 'none' | 'queued' | 'building' | 'success' | 'failed';

export interface Work {
  id: string;
  title: string;
  description: string;
  creator: string;
  createdAt: number;
  lastUpdate: number;
  publishedSha: string | null;
  buildStatus: BuildStatus;
  buildLog: string | null;
}

/** /api/works/:id 详情附带字段 */
export interface WorkDetail extends Work {
  isOwner: boolean;
  runSha: string | null;
  queuePosition: number | null;
}

export interface PublicUser {
  name: string;
  nickname: string;
  bio: string;
  avatar: string;
  createdAt?: number;
}

export interface OwnUser extends PublicUser {
  email: string;
  emailVerified: boolean;
  hasPassword: boolean;
}

export interface FileEntry {
  path: string;
  type: 'file' | 'dir';
}

export interface HistoryEntry {
  sha: string;
  message: string;
  author: string;
  time: number;
}

export interface GitInfo {
  workId: string;
  remote: string;
  publicUrl: string;
  auth: { username: string; password: string };
}

export interface ToolchainInfo {
  ok: boolean;
  mode: 'container' | 'local';
  version?: string;
  path?: string;
  hint?: string | null;
}

/* ---------------- 接口响应外壳 ---------------- */

export interface ApiOk<T = unknown> {
  ok: true;
  [key: string]: unknown;
}

export interface HomeWorksResponse {
  ok: true;
  windowDays: number;
  now: number;
  works: Work[];
}

export interface WorkDetailResponse {
  ok: true;
  work: WorkDetail;
}

export interface FilesResponse {
  ok: true;
  files: FileEntry[];
}

export interface HistoryResponse {
  ok: true;
  history: HistoryEntry[];
}

export interface ContentResponse {
  ok: true;
  content: string;
}

export interface MeResponse {
  ok: true;
  creator: string;
  user: OwnUser;
  works: Work[];
}

export interface CreatorResponse {
  ok: true;
  user: PublicUser;
  works: Work[];
}

export interface LoginResponse {
  ok: true;
  name: string;
  token: string;
  user: OwnUser;
}

export interface RegisterResponse {
  ok: true;
  name: string;
  needsVerify: boolean;
  /** 仅开发模式(未配置 SMTP)返回, 便于本地体验 */
  verificationToken?: string;
}

export interface VerifyResponse {
  ok: true;
  name: string;
  email: string;
  kind: string;
}
