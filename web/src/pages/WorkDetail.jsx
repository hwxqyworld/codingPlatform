import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtTime } from '../api.js';

/**
 * 作品详情页: 运行(iframe 加载编译产物) / 源码浏览 / 更新记录 / 构建日志。
 */
export default function WorkDetail() {
  const { id } = useParams();
  const [work, setWork] = useState(null);
  const [files, setFiles] = useState([]);
  const [history, setHistory] = useState([]);
  const [content, setContent] = useState('');
  const [currentFile, setCurrentFile] = useState('');
  const [tab, setTab] = useState('run');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .work(id)
      .then(async (d) => {
        setWork(d.work);
        // 并行加载文件树与更新记录
        const [f, h] = await Promise.all([api.files(id), api.history(id)]);
        setFiles(f.files);
        setHistory(h.history);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  /** 点击文件树节点 -> 读取源码 */
  const openFile = async (p) => {
    try {
      const d = await api.readFile(id, p);
      setCurrentFile(p);
      setContent(d.content);
      setTab('source');
    } catch (e) {
      setError(e.message);
    }
  };

  if (error) return <div className="empty">加载失败: {error}</div>;
  if (!work) return <div className="empty">加载中…</div>;

  const statusMap = {
    none: ['私有(未发布)', 'muted'],
    queued: ['排队中…', 'yellow'],
    building: ['构建中…', 'yellow'],
    success: ['已发布', 'green'],
    failed: ['构建失败', 'red'],
  };
  const [statusLabel, statusCls] = statusMap[work.buildStatus] || statusMap.none;

  // 运行版本说明: 最近一次提交构建成功则运行它; 否则运行最近一次有效构建
  const runningOlder =
    work.publishedSha && work.runSha && work.runSha !== work.publishedSha;

  return (
    <div className="page">
      <div className="work-head">
        <h1>{work.title}</h1>
        <div className="work-meta">
          <span>👤 {work.creator}</span>
          <span>🕐 最近更新 {fmtTime(work.lastUpdate)}</span>
          <span className={`badge ${statusCls}`}>{statusLabel}</span>
          {work.buildStatus === 'queued' && work.queuePosition > 0 && (
            <span className="badge yellow">队伍第 {work.queuePosition} 位</span>
          )}
          {work.isOwner && (
            <Link className="btn btn-primary btn-sm" to={`/edit/${work.id}`}>✏ 进入编辑器</Link>
          )}
        </div>
        <p className="work-desc">{work.description}</p>
      </div>

      <div className="tabs">
        <button className={tab === 'run' ? 'tab active' : 'tab'} onClick={() => setTab('run')}>▶ 运行</button>
        <button className={tab === 'source' ? 'tab active' : 'tab'} onClick={() => setTab('source')}>源码</button>
        <button className={tab === 'history' ? 'tab active' : 'tab'} onClick={() => setTab('history')}>更新记录</button>
        {work.buildStatus === 'failed' && (
          <button className={tab === 'log' ? 'tab active' : 'tab'} onClick={() => setTab('log')}>构建日志</button>
        )}
      </div>

      {/* 运行: iframe 加载 /w/<id>/ 编译产物(始终是最近一次有效构建); key 用运行版本 sha, 新构建自动刷新 */}
      {tab === 'run' &&
        (work.runSha ? (
          <>
            {runningOlder && (
              <div className="alert info" style={{ margin: '12px 0' }}>
                最新提交({work.publishedSha.slice(0, 7)})构建未成功, 当前运行的是最近一次有效构建。
              </div>
            )}
            <div className="player">
              <iframe
                key={work.runSha}
                src={`/w/${work.id}/`}
                sandbox="allow-scripts allow-same-origin allow-pointer-lock"
                title="作品运行区"
              />
            </div>
          </>
        ) : work.publishedSha ? (
          <div className="empty">
            构建尚未成功, 暂无可运行的版本。
            {work.isOwner && ' 请在编辑器里查看构建日志并重新构建。'}
          </div>
        ) : (
          <div className="empty">该作品尚未发布(私有)。推送 main 分支并构建成功后即可公开运行。</div>
        ))}

      {/* 源码浏览 */}
      {tab === 'source' && (
        <div className="source-pane">
          <aside className="tree">
            {files
              .filter((f) => f.type === 'file')
              .map((f) => (
                <button
                  key={f.path}
                  className={f.path === currentFile ? 'active' : ''}
                  onClick={() => openFile(f.path)}
                >
                  {f.path}
                </button>
              ))}
          </aside>
          <pre className="code">
            {currentFile ? `// ${currentFile}\n\n${content}` : '点击左侧文件查看源码'}
          </pre>
        </div>
      )}

      {/* 更新记录 */}
      {tab === 'history' && (
        <ul className="history">
          {history.map((h) => (
            <li key={h.sha}>
              <code>{h.sha}</code>
              <span>{h.message}</span>
              <span className="muted">{h.author} · {new Date(h.time).toLocaleString()}</span>
            </li>
          ))}
          {history.length === 0 && <li>暂无提交记录</li>}
        </ul>
      )}

      {/* 构建日志 */}
      {tab === 'log' && <pre className="code log">{work.buildLog || '（无日志）'}</pre>}
    </div>
  );
}
