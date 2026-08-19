import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchJson } from '@/lib/server';
import type { HomeWorksResponse, Work } from '@/lib/types';
import HomeWorks from '@/components/HomeWorks';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '最近更新的作品 — 用 C++/SDL2 创作, 浏览器即玩',
  description:
    '创玩主页: 最近 30 天内有更新、且 main 分支构建成功的 C++/SDL2 作品。不按热度排序, 每个作品获得同等曝光。',
  alternates: { canonical: '/' },
};

async function getData(): Promise<{ works: Work[]; windowDays: number; total: number }> {
  const [home, all] = await Promise.all([
    fetchJson<HomeWorksResponse>('/api/works'),
    fetchJson<{ ok: true; works: Work[] }>('/api/works/all'),
  ]);
  return { works: home.works, windowDays: home.windowDays, total: all.works.length };
}

/** 主页: SSR 直出作品列表(SEO), 客户端增量刷新构建状态 */
export default async function HomePage() {
  const { works, windowDays, total } = await getData();
  const creators = new Set(works.map((w) => w.creator)).size;

  return (
    <div className="page">
      {/* Hero */}
      <section className="hero" aria-labelledby="hero-title">
        <span className="hero-kicker">🚀 C++ → WebAssembly</span>
        <h1 id="hero-title">
          用 <span className="grad">C++/SDL2</span> 创作
          <br />
          浏览器里直接游玩
        </h1>
        <p className="hero-sub">
          创玩把 C++ 作品用 Emscripten 编译成 WebAssembly —— 无需安装、即点即玩。
          支持在线编辑器(类 VSCode)与 git 命令行两种创作方式。
        </p>
        <div className="hero-actions">
          <Link className="btn btn-primary" href="/manage">
            ✏ 开始创作
          </Link>
          <Link className="btn" href="/all">
            浏览全部作品
          </Link>
        </div>
        <div className="hero-stats">
          <div className="stat">
            <b>{works.length}</b>
            <span>近 {windowDays} 天更新</span>
          </div>
          <div className="stat">
            <b>{total}</b>
            <span>全部作品</span>
          </div>
          <div className="stat">
            <b>{creators}</b>
            <span>活跃创作者</span>
          </div>
        </div>
      </section>

      {/* 最近更新作品 */}
      <section aria-labelledby="recent-title">
        <div className="section-head">
          <h2 id="recent-title">最近更新的作品</h2>
          <Link className="section-more" href="/all">
            查看全部 →
          </Link>
        </div>
        <HomeWorks initial={works} windowDays={windowDays} />
      </section>
    </div>
  );
}
