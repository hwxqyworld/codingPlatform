import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchJson } from '@/lib/server';
import { PUBLIC_URL } from '@/lib/env';
import type { CreatorResponse } from '@/lib/types';
import WorkGrid from '@/components/WorkGrid';

export const dynamic = 'force-dynamic';

/** 路由参数可能未解码(含中文的用户名), 统一解码一次; 已解码时是幂等操作 */
function decodeParam(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface PageProps {
  params: Promise<{ name: string }>;
}

/** 创作者主页: 资料 + 已发布作品(公开, SEO 收录) */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { name: raw } = await params;
  const name = decodeParam(raw);
  try {
    const d = await fetchJson<CreatorResponse>(`/api/creators/${encodeURIComponent(name)}`);
    const nickname = d.user.nickname || d.user.name;
    return {
      title: `${nickname} 的作品`,
      description: (d.user.bio || `${nickname} 在创玩平台发布的 C++/SDL2 作品`).slice(0, 160),
      alternates: { canonical: `/creator/${encodeURIComponent(name)}` },
      openGraph: {
        type: 'profile',
        url: `${PUBLIC_URL}/creator/${encodeURIComponent(name)}`,
        title: `${nickname} 的作品 — 创玩`,
        description: d.user.bio || undefined,
      },
    };
  } catch {
    return { title: '创作者不存在' };
  }
}

export default async function CreatorPage({ params }: PageProps) {
  const { name: raw } = await params;
  const name = decodeParam(raw);
  let data: CreatorResponse;
  try {
    data = await fetchJson<CreatorResponse>(`/api/creators/${encodeURIComponent(name)}`);
  } catch {
    notFound();
  }

  const { user, works } = data;
  const nickname = user.nickname || user.name;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person',
      name: nickname,
      description: user.bio || undefined,
    },
  };

  return (
    <div className="page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="creator-head">
        <div className="creator-avatar" aria-hidden="true">
          {user.avatar || nickname.charAt(0).toUpperCase()}
        </div>
        <div>
          <h1>{nickname}</h1>
          {user.bio ? (
            <p className="creator-bio">{user.bio}</p>
          ) : (
            <p className="creator-bio">创玩平台创作者</p>
          )}
        </div>
      </div>
      <div className="section-head">
        <h2>TA 的作品 ({works.length})</h2>
      </div>
      <WorkGrid works={works} empty="还没有发布的作品" />
    </div>
  );
}
