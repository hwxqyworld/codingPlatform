import type { Metadata } from 'next';
import { fetchJson } from '@/lib/server';
import type { Work } from '@/lib/types';
import WorkGrid from '@/components/WorkGrid';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '全部作品',
  description: '创玩平台上所有 main 分支构建成功的 C++/SDL2 作品, 按最近更新时间倒序排列。',
  alternates: { canonical: '/all' },
};

/** 全部已发布作品(不受 30 天窗口限制) */
export default async function AllWorksPage() {
  const data = await fetchJson<{ ok: true; works: Work[] }>('/api/works/all');

  return (
    <div className="page">
      <div className="section-head" style={{ marginBottom: 22 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>全部作品</h1>
      </div>
      <p className="work-desc" style={{ marginBottom: 22 }}>
        平台上所有 main 分支存在构建成功版本的作品(构建与提交绑定), 按最近更新时间倒序排列。
      </p>
      <WorkGrid works={data.works} empty="还没有作品发布, 成为第一个创作者吧 🚀" />
    </div>
  );
}
