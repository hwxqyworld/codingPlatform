'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { FileEntry, HistoryEntry, WorkDetail } from '@/lib/types';

type Tab = 'run' | 'source' | 'history' | 'log';

/**
 * 作品详情页交互区(运行 / 源码 / 更新记录 / 构建日志)。
 * 构建中/排队中时轮询作品状态, 完成后自动刷新运行区。
 */
export default function WorkTabs({
  work: initial,
  initialFiles,
  initialHistory,
}: {
  work: WorkDetail;
  initialFiles: FileEntry[];
  initialHistory: HistoryEntry[];
}) {
  const [work, setWork] = useState(initial);
  const [files, setFiles] = useState(initialFiles);
  const [history, setHistory] = useState(initialHistory);
  const [tab, setTab] = useState<Tab>('run');
  const [content, setContent] = useState('');
  const [currentFile, setCurrentFile] = useState('');
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  // 排队中/构建中 -> 每 2s 轮询状态
  useEffect(() => {
    if (!['queued', 'building'].includes(work.buildStatus)) return;
    const timer = setInterval(async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const d = await api.work(work.id);
        setWork(d.work);
      } catch {
        /* 轮询失败忽略 */
      } finally {
        busyRef.current = false;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [work.buildStatus, work.id]);

  /** 点击文件树节点 -> 读取源码 */
  const openFile = async (p: string) => {
    try {
      const d = await api.readFile(work.id, p);
      setCurrentFile(p);
      setContent(d.content);
      setTab('source');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (error) return <div className="empty">加载失败: {error}</div>;

  // 运行版本说明: 最近一次提交构建成功则运行它; 否则运行最近一次有效构建
  const runningOlder = work.publishedSha && work.runSha && work.runSha !== work.publishedSha;

  return (
    <div>
      <div className="tabs" role="tablist" aria-label="作品页签">
        <button
          role="tab"
          aria-selected={tab === 'run'}
          className={tab === 'run' ? 'tab active' : 'tab'}
          onClick={() => setTab('run')}
        >
          ▶ 运行
        </button>
        <button
          role="tab"
          aria-selected={tab === 'source'}
          className={tab === 'source' ? 'tab active' : 'tab'}
          onClick={() => setTab('source')}
        >
          源码
        </button>
        <button
          role="tab"
          aria-selected={tab === 'history'}
          className={tab === 'history' ? 'tab active' : 'tab'}
          onClick={() => setTab('history')}
        >
          更新记录
        </button>
        {work.buildStatus === 'failed' && (
          <button
            role="tab"
            aria-selected={tab === 'log'}
            className={tab === 'log' ? 'tab active' : 'tab'}
            onClick={() => setTab('log')}
          >
            构建日志
          </button>
        )}
      </div>

      {/* 运行: iframe 加载 /w/<id>/ 编译产物(始终是最近一次有效构建); key 用运行版本 sha, 新构建自动刷新 */}
      {tab === 'run' &&
        (work.runSha ? (
          <>
            {runningOlder && (
              <div className="alert info" style={{ marginBottom: 12 }}>
                最新提交({work.publishedSha?.slice(0, 7)})构建未成功, 当前运行的是最近一次有效构建。
              </div>
            )}
            <div className="player">
              <iframe
                key={work.runSha}
                src={`/w/${work.id}/`}
                sandbox="allow-scripts allow-same-origin allow-pointer-lock"
                title={`作品 ${work.title} 运行区`}
                loading="lazy"
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
          <aside className="tree" aria-label="源码文件列表">
            {files
              .filter((f) => f.type === 'file')
              .map((f) => (
                <button
                  key={f.path}
                  className={f.path === currentFile ? 'active' : ''}
                  onClick={() => openFile(f.path)}
                  title={f.path}
                >
                  {f.path}
                </button>
              ))}
            {files.length === 0 && (
              <div style={{ color: 'var(--muted)', padding: 10, fontSize: 12.5 }}>暂无文件</div>
            )}
          </aside>
          <pre className="code" aria-live="polite">
            {currentFile ? `// ${currentFile}\n\n${content}` : '点击左侧文件查看源码'}
          </pre>
        </div>
      )}

      {/* 更新记录 */}
      {tab === 'history' && (
        <ul className="history">
          {history.map((h) => (
            <li key={h.sha}>
              <code>{h.sha.slice(0, 7)}</code>
              <span>{h.message}</span>
              <span className="muted">
                {h.author} · {new Date(h.time).toLocaleString()}
              </span>
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
