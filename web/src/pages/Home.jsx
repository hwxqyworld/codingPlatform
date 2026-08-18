import { useEffect, useState } from 'react';
import { api } from '../api.js';
import WorkCard from '../components/WorkCard.jsx';

/**
 * 主页 —— 按平台规则展示作品:
 *   最近 30 天内有更新(main 推送)的作品, 按更新时间倒序,
 *   不按热度排序, 每个作品获得同等曝光。
 */
export default function Home() {
  const [works, setWorks] = useState(null);
  const [windowDays, setWindowDays] = useState(30);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .homeWorks()
      .then((d) => {
        setWorks(d.works);
        setWindowDays(d.windowDays);
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="page">
      <div className="banner">
        <h1>最近更新的作品</h1>
        <p>
          收录规则: 最近 {windowDays} 天内有更新、且 main 分支存在构建成功版本的作品(构建与提交绑定)。
          不按热度排序, 每个作品获得同等曝光。
        </p>
      </div>

      {error && <div className="alert error">{error}</div>}
      {!works && !error && <div className="empty">加载中…</div>}
      {works && works.length === 0 && (
        <div className="empty">最近 {windowDays} 天还没有构建成功的新作品, 快去创作吧 🚀</div>
      )}

      <div className="grid">
        {works?.map((w) => <WorkCard key={w.id} work={w} />)}
      </div>
    </div>
  );
}
