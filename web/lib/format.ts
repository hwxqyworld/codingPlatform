import type { BuildStatus } from './types';

/** 相对时间格式化(主页/卡片展示用) */
export function fmtTime(ts: number | null | undefined): string {
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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** 由作品 id 生成稳定的色相, 用于卡片渐变占位图 */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 构建状态 -> [徽章文案, 样式类] */
const STATUS_MAP: Record<string, [string, string]> = {
  none: ['私有', 'muted'],
  queued: ['排队中', 'yellow'],
  building: ['构建中', 'yellow'],
  success: ['已发布', 'green'],
  failed: ['构建失败', 'red'],
};

const STATUS_FALLBACK: [string, string] = ['私有', 'muted'];

/** 取构建状态徽章文案与样式(不存在时回退「私有」) */
export function statusOf(status: BuildStatus | undefined): [string, string] {
  return (status ? STATUS_MAP[status] : undefined) ?? STATUS_FALLBACK;
}
