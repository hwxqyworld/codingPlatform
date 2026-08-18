import { useEffect, useState } from 'react';
import { api } from '../api.js';
import WorkCard from '../components/WorkCard.jsx';

/** 全部已发布作品(不受 30 天窗口限制) */
export default function AllWorks() {
  const [works, setWorks] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .allWorks()
      .then((d) => setWorks(d.works))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="page">
      <div className="banner">
        <h1>全部作品</h1>
        <p>平台上所有 main 分支存在构建成功版本的作品(构建与提交绑定), 同样按最近更新时间倒序排列。</p>
      </div>

      {error && <div className="alert error">{error}</div>}
      {!works && !error && <div className="empty">加载中…</div>}
      {works && works.length === 0 && <div className="empty">还没有作品发布</div>}

      <div className="grid">
        {works?.map((w) => <WorkCard key={w.id} work={w} />)}
      </div>
    </div>
  );
}
