import WorkCard from './WorkCard';
import type { Work } from '@/lib/types';

/** 作品网格(服务端/客户端通用) */
export default function WorkGrid({
  works,
  empty,
}: {
  works: Work[] | null;
  empty: string;
}) {
  if (works === null) return <SkeletonGrid />;
  if (works.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="grid">
      {works.map((w) => (
        <WorkCard key={w.id} work={w} />
      ))}
    </div>
  );
}

/** 加载骨架屏: 与真实卡片同尺寸, 避免布局跳动 */
export function SkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="skeleton-card skeleton" key={i} />
      ))}
    </div>
  );
}
