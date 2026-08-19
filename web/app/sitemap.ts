import type { MetadataRoute } from 'next';
import { fetchJson } from '@/lib/server';
import { PUBLIC_URL } from '@/lib/env';
import type { Work } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * 站点地图: 动态生成(每次请求实时查询后端, 收录新作品/创作者)。
 * 私有草稿与构建失败作品不会被收录(接口本身即过滤)。
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = PUBLIC_URL;
  const entries: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${base}/all`, changeFrequency: 'daily', priority: 0.8 },
  ];

  try {
    const [all, home] = await Promise.all([
      fetchJson<{ ok: true; works: Work[] }>('/api/works/all'),
      fetchJson<{ ok: true; works: Work[] }>('/api/works'),
    ]);
    for (const w of all.works) {
      entries.push({
        url: `${base}/work/${w.id}`,
        lastModified: w.lastUpdate ? new Date(w.lastUpdate) : undefined,
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
    const creators = [...new Set(all.works.map((w) => w.creator))];
    for (const name of creators) {
      entries.push({
        url: `${base}/creator/${encodeURIComponent(name)}`,
        changeFrequency: 'weekly',
        priority: 0.5,
      });
    }
    void home;
  } catch {
    /* 后端暂不可用时返回基础条目 */
  }

  return entries;
}
