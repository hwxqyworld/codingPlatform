import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchJson } from '@/lib/server';
import { PUBLIC_URL } from '@/lib/env';
import type { FileEntry, HistoryEntry, WorkDetail } from '@/lib/types';
import WorkTabs from '@/components/WorkTabs';
import WorkDetailHead from '@/components/WorkDetailHead';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

async function getWork(id: string): Promise<WorkDetail | null> {
  try {
    const d = await fetchJson<{ ok: true; work: WorkDetail }>(`/api/works/${id}`);
    return d.work;
  } catch {
    return null; // 404 / 私有草稿 -> notFound()
  }
}

/** 作品详情页 SEO: 标题/描述/OG 与 JSON-LD 结构化数据 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const work = await getWork(id);
  if (!work) return { title: '作品不存在' };
  const url = `${PUBLIC_URL}/work/${work.id}`;
  const description = (work.description || `${work.creator} 用 C++/SDL2 创作的作品`).slice(0, 160);
  return {
    title: work.title,
    description,
    alternates: { canonical: `/work/${work.id}` },
    openGraph: {
      type: 'article',
      url,
      title: `${work.title} — ${work.creator} 的作品`,
      description,
      siteName: '创玩',
      locale: 'zh_CN',
      publishedTime: work.createdAt ? new Date(work.createdAt).toISOString() : undefined,
      modifiedTime: work.lastUpdate ? new Date(work.lastUpdate).toISOString() : undefined,
      authors: [work.creator],
    },
  };
}

export default async function WorkDetailPage({ params }: PageProps) {
  const { id } = await params;
  const work = await getWork(id);
  if (!work) notFound();

  // 并行加载文件树与更新记录
  let files: FileEntry[] = [];
  let history: HistoryEntry[] = [];
  try {
    const [f, h] = await Promise.all([
      fetchJson<{ ok: true; files: FileEntry[] }>(`/api/works/${id}/files`),
      fetchJson<{ ok: true; history: HistoryEntry[] }>(`/api/works/${id}/history`),
    ]);
    files = f.files;
    history = h.history;
  } catch {
    /* 未发布/私有等场景下文件树不可读 -> 空列表, 由界面兜底 */
  }

  // JSON-LD 结构化数据: 便于搜索引擎理解作品内容
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: work.title,
    description: work.description || undefined,
    author: { '@type': 'Person', name: work.creator },
    dateCreated: work.createdAt ? new Date(work.createdAt).toISOString() : undefined,
    dateModified: work.lastUpdate ? new Date(work.lastUpdate).toISOString() : undefined,
    url: `${PUBLIC_URL}/work/${work.id}`,
    inLanguage: 'zh-CN',
    ...(work.buildStatus === 'success'
      ? {
          offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'CNY',
            availability: 'https://schema.org/InStock',
          },
        }
      : {}),
  };

  return (
    <div className="page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <WorkDetailHead work={work} />
      <WorkTabs work={work} initialFiles={files} initialHistory={history} />
    </div>
  );
}
