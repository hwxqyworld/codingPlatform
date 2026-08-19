'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Work } from '@/lib/types';
import { api } from '@/lib/api';
import WorkGrid from './WorkGrid';

/**
 * 主页作品列表(客户端):
 * SSR 直出的初始数据 + 有作品处于「排队中/构建中」时轮询刷新,
 * 构建完成自动出现在列表里, 无需手动刷新。
 */
export default function HomeWorks({
  initial,
  windowDays,
}: {
  initial: Work[];
  windowDays: number;
}) {
  const router = useRouter();
  const [works, setWorks] = useState<Work[]>(initial);
  const busyRef = useRef(false);

  // 有任何作品在构建/排队中 -> 每 3s 拉取一次最新列表
  useEffect(() => {
    const building = works.some((w) => w.buildStatus === 'building' || w.buildStatus === 'queued');
    if (!building) return;
    const timer = setInterval(async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const d = await api.homeWorks();
        setWorks(d.works);
      } catch {
        /* 轮询失败忽略, 下轮重试 */
      } finally {
        busyRef.current = false;
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [works]);

  // 页面重新可见时刷新一次(后台切回)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [router]);

  return (
    <WorkGrid
      works={works}
      empty={`最近 ${windowDays} 天还没有构建成功的新作品, 快去创作吧 🚀`}
    />
  );
}
