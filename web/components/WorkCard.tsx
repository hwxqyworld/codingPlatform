import Link from 'next/link';
import type { Work } from '@/lib/types';
import { fmtTime, hueOf, statusOf } from '@/lib/format';

/**
 * 作品卡片(服务端/客户端通用)。
 * 刻意不展示任何热度数据(浏览量/点赞等) —— 平台规则是人人平等曝光。
 * 缩略图: 由作品 id 生成稳定色相的渐变占位 + 标题首字。
 */
export default function WorkCard({ work }: { work: Work }) {
  const [label, cls] = statusOf(work.buildStatus);
  const hue = hueOf(work.id);
  const letter = (work.title || '?').trim().charAt(0) || '?';

  return (
    <Link href={`/work/${work.id}`} className="card" aria-label={`查看作品: ${work.title}`}>
      <div
        className="card-thumb"
        aria-hidden="true"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 72% 52%), hsl(${(hue + 48) % 360} 74% 42%))`,
        }}
      >
        <span className="thumb-letter">{letter}</span>
      </div>
      <div className="card-body">
        <div className="card-head">
          <span className="card-title" title={work.title}>
            {work.title}
          </span>
          <span className={`badge ${cls}`}>{label}</span>
        </div>
        <p className="card-desc">{work.description || '（暂无简介）'}</p>
        <div className="card-foot">
          <span title={`创作者: ${work.creator}`}>👤 {work.creator}</span>
          <span title={work.lastUpdate ? new Date(work.lastUpdate).toLocaleString() : undefined}>
            🕐 {fmtTime(work.lastUpdate)}
          </span>
        </div>
      </div>
    </Link>
  );
}
