import Link from 'next/link';
import type { WorkDetail } from '@/lib/types';
import { fmtTime, statusOf } from '@/lib/format';

/** 作品详情头部(标题/创作者/状态/简介) */
export default function WorkDetailHead({ work }: { work: WorkDetail }) {
  const [statusLabel, statusCls] = statusOf(work.buildStatus);

  return (
    <div className="work-head">
      <h1>{work.title}</h1>
      <div className="work-meta">
        <Link href={`/creator/${encodeURIComponent(work.creator)}`} className="meta-creator">
          👤 {work.creator}
        </Link>
        <span title={work.lastUpdate ? new Date(work.lastUpdate).toLocaleString() : undefined}>
          🕐 最近更新 {fmtTime(work.lastUpdate)}
        </span>
        <span className={`badge ${statusCls}`}>{statusLabel}</span>
        {work.buildStatus === 'queued' && work.queuePosition !== null && work.queuePosition > 0 && (
          <span className="badge yellow">队伍第 {work.queuePosition} 位</span>
        )}
        {work.isOwner && (
          <Link className="btn btn-primary btn-sm" href={`/edit/${work.id}`}>
            ✏ 进入编辑器
          </Link>
        )}
      </div>
      {work.description && <p className="work-desc">{work.description}</p>}
    </div>
  );
}
