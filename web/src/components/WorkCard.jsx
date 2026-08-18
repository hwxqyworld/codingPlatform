import { Link } from 'react-router-dom';
import { fmtTime } from '../api.js';

/** 构建状态 -> [徽章文案, 样式类] */
const STATUS = {
  none: ['私有', 'muted'],
  building: ['构建中', 'yellow'],
  success: ['已发布', 'green'],
  failed: ['构建失败', 'red'],
};

/**
 * 主页作品卡片。
 * 刻意不展示任何热度数据(浏览量/点赞等) —— 平台规则是人人平等曝光。
 */
export default function WorkCard({ work }) {
  const [label, cls] = STATUS[work.buildStatus] || STATUS.none;
  return (
    <Link to={`/work/${work.id}`} className="card">
      <div className="card-head">
        <span className="card-title" title={work.title}>{work.title}</span>
        <span className={`badge ${cls}`}>{label}</span>
      </div>
      <p className="card-desc">{work.description || '（暂无简介）'}</p>
      <div className="card-foot">
        <span>👤 {work.creator}</span>
        <span title={new Date(work.lastUpdate).toLocaleString()}>
          🕐 {fmtTime(work.lastUpdate)}
        </span>
      </div>
    </Link>
  );
}
