'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import type { OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { statusOf } from '@/lib/format';
import type { FileEntry, WorkDetail } from '@/lib/types';

/**
 * Monaco 编辑器懒加载:
 *  - ssr: false —— 只在浏览器加载(Monaco 依赖 window)
 *  - 与 next.config 的 monaco-editor-webpack-plugin 配合, worker 本地打包
 */
const MonacoEditor = dynamic(
  () => import('@/components/editor/MonacoWrap').then((m) => m.default),
  { ssr: false, loading: () => <div className="editor-placeholder">正在加载编辑器…</div> },
);

/** 扩展名 -> Monaco 语言 id */
const LANG: Record<string, string> = {
  cpp: 'cpp', c: 'cpp', h: 'cpp', hpp: 'cpp', hh: 'cpp', cc: 'cpp',
  json: 'json', md: 'markdown', txt: 'plaintext',
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  html: 'html', css: 'css', py: 'python', sh: 'shell', bat: 'bat', cmake: 'cmake', yaml: 'yaml',
};
const langOf = (p: string): string => LANG[(p.split('.').pop() || '').toLowerCase()] || 'plaintext';

/**
 * 在线编辑器(类 VSCode) —— 平台核心页面。
 *
 * 工作流:
 *   保存/文件操作 -> 编辑器目录(develop 的物化内容)
 *   提交           -> 提交到 develop 分支(内部, 不公开)
 *   发布           -> develop 推送 main(公开作品 + 触发平台构建 + 计一次更新)
 *   同步           -> 拉取外部 git 推送的 develop 更新
 */
export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { creator, ready, token } = useAuth();
  const router = useRouter();

  const [work, setWork] = useState<WorkDetail | null>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [current, setCurrent] = useState(''); // 当前打开的文件
  const [content, setContent] = useState(''); // 编辑器内容
  const [dirty, setDirty] = useState(false); // 是否有未保存改动
  const [commitMsg, setCommitMsg] = useState('更新作品');
  const [msg, setMsg] = useState(''); // 底部操作提示
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState('');
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [editorTheme, setEditorTheme] = useState<'vs' | 'vs-dark'>('vs');

  // 始终读取最新值(避免 Monaco onMount 一次性绑定的闭包捕获旧状态)
  const currentRef = useRef('');
  currentRef.current = current;
  const contentRef = useRef('');
  contentRef.current = content;

  /** 加载作品与文件树 */
  const load = async () => {
    const d = await api.work(id);
    if (!d.work.isOwner) throw new Error('你不是该作品的创作者');
    setWork(d.work);
    const f = await api.files(id);
    setFiles(f.files);
  };

  const refresh = async () => {
    const f = await api.files(id);
    setFiles(f.files);
  };

  useEffect(() => {
    if (!ready) return; // 等待客户端会话恢复, 避免误跳登录页
    if (!creator) {
      router.replace('/login');
      return;
    }
    load().catch((e) => setMsg(`加载失败: ${e instanceof Error ? e.message : String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, creator, ready]);

  // 编辑器主题跟随站点主题
  useEffect(() => {
    const apply = () =>
      setEditorTheme(document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs');
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  /** 排队中/构建中 -> 每 1.5s 轮询一次状态 */
  useEffect(() => {
    if (!work || !['queued', 'building'].includes(work.buildStatus)) return;
    const timer = setInterval(async () => {
      try {
        const d = await api.work(id);
        setWork(d.work);
        if (!['queued', 'building'].includes(d.work.buildStatus)) {
          setMsg(
            d.work.buildStatus === 'success'
              ? '✓ 构建成功, 作品已公开并计入主页更新'
              : '✗ 构建失败, 作品暂不更新, 详见构建日志',
          );
        }
      } catch {
        /* 轮询失败忽略, 下轮重试 */
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [work?.buildStatus, id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Monaco 挂载: 绑定 Ctrl/Cmd+S 保存(命令只绑定一次, 通过 ref 读取最新状态) */
  const handleMount: OnMount = (ed, monacoInstance) => {
    editorRef.current = ed;
    ed.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => save());
  };

  /** 文件切换时把内容推给编辑器(已是最新内容时跳过, 避免光标跳动) */
  useEffect(() => {
    const ed = editorRef.current;
    if (ed && ed.getValue() !== content) ed.setValue(content);
  }, [current, content]);

  // ---------------- 操作 ----------------

  const openFile = async (p: string) => {
    try {
      const d = await api.readFile(id, p);
      setCurrent(p);
      setContent(d.content);
      setDirty(false);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!currentRef.current) return;
    setBusy('保存');
    setMsg('');
    try {
      const value = editorRef.current?.getValue() ?? contentRef.current;
      await api.saveFile(id, currentRef.current, value);
      setContent(value);
      setDirty(false);
      setMsg(`已保存 ${currentRef.current}`);
    } catch (e) {
      setMsg(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  };
  const commit = async () => {
    setBusy('提交');
    setMsg('');
    try {
      const d = await api.commit(id, commitMsg);
      setMsg(`✓ 已提交到 develop(${d.sha.slice(0, 7)}), 尚未公开`);
    } catch (e) {
      setMsg(`提交失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  };

  const publish = async () => {
    setBusy('发布');
    setMsg('');
    try {
      await api.publish(id);
      setMsg('已推送到 main, 平台正在构建…');
      const d = await api.work(id);
      setWork(d.work); // buildStatus -> building, 触发上方轮询
    } catch (e) {
      setMsg(`发布失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  };

  const rebuild = async () => {
    try {
      await api.build(id);
      setMsg('已开始重新构建…');
      const d = await api.work(id);
      setWork(d.work);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const sync = async () => {
    try {
      await api.sync(id);
      await refresh();
      setMsg('✓ 已同步 develop 的最新内容');
    } catch (e) {
      setMsg(`同步失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---------------- 文件操作 ----------------

  const newFile = async () => {
    const name = window.prompt('新建文件(支持子目录, 如 src/game.cpp):');
    if (!name) return;
    try {
      await api.saveFile(id, name, '');
      await refresh();
      setMsg(`已创建 ${name}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const renameFile = async (p: string) => {
    const to = window.prompt('新路径:', p);
    if (!to || to === p) return;
    try {
      await api.moveFile(id, p, to);
      if (current === p) setCurrent(to);
      await refresh();
      setMsg(`已重命名 → ${to}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const removeFile = async (p: string) => {
    if (!window.confirm(`确定删除 ${p} 吗?`)) return;
    try {
      await api.deleteFile(id, p);
      if (current === p) {
        setCurrent('');
        setContent('');
      }
      await refresh();
      setMsg(`已删除 ${p}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const d = await api.upload(id, file);
      await refresh();
      setMsg(`已上传 ${d.path}(记得提交到 develop)`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
    e.target.value = '';
  };

  // ---------------- 渲染 ----------------

  if (!ready || !creator) {
    return <div className="empty">{msg || '加载中…'}</div>;
  }

  if (work === null) {
    return <div className="empty">{msg || '加载中…'}</div>;
  }

  const [statusLabel, statusCls] = statusOf(work.buildStatus);
  const fileList = files?.filter((f) => f.type === 'file') ?? [];

  return (
    <div className="editor-page">
      {/* 排队提示: 构建容器繁忙时的等待状态 */}
      {work.buildStatus === 'queued' && (
        <div className="alert info" style={{ borderRadius: 0, margin: 0 }}>
          ⏳ 服务器繁忙, 你正在队伍第{work.queuePosition ?? '…'}位, 请稍候(构建会自动开始)
        </div>
      )}
      {/* 顶部工具栏 */}
      <div className="editor-toolbar">
        <span className="title" title={work.title}>
          {work.title}
        </span>
        <span className={`badge ${statusCls}`}>{statusLabel}</span>
        <span className="badge muted">分支 develop(内部)</span>
        <span className="hint" title={msg || undefined}>
          {msg || `最近更新: ${new Date(work.lastUpdate).toLocaleString()}`}
        </span>
        {work.buildStatus === 'failed' && (
          <button className="btn btn-sm" onClick={rebuild} disabled={!!busy}>
            ↻ 重新构建
          </button>
        )}
        <button className="btn btn-sm" onClick={sync} disabled={!!busy}>
          ⇄ 同步
        </button>
        <button className="btn btn-sm" onClick={() => setShowLog((v) => !v)} disabled={!!busy}>
          {showLog ? '隐藏日志' : '构建日志'}
        </button>
        <button className="btn btn-sm" onClick={() => router.push(`/work/${id}`)}>
          查看作品页
        </button>
      </div>

      {/* 主体: 文件树 + 编辑器 */}
      <div className="editor-body">
        <aside className="editor-side" aria-label="文件操作区">
          <div className="editor-side-head">
            <span>📁 文件</span>
            <span className="spacer" />
            <button className="icon-btn" title="新建文件" onClick={newFile} aria-label="新建文件">
              ＋
            </button>
            <button
              className="icon-btn"
              title="上传资源到 assets/"
              onClick={() => fileRef.current?.click()}
              aria-label="上传文件"
            >
              ↑
            </button>
            <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={upload} />
          </div>
          <div className="tree">
            {fileList.map((f) => (
              <div key={f.path} className="file-row">
                <button
                  className={`file-name${f.path === current ? ' active' : ''}`}
                  onClick={() => openFile(f.path)}
                  title={f.path}
                >
                  {f.path}
                </button>
                <button
                  className="file-action"
                  title="重命名"
                  onClick={() => renameFile(f.path)}
                  aria-label={`重命名 ${f.path}`}
                >
                  ✎
                </button>
                <button
                  className="file-action"
                  title="删除"
                  onClick={() => removeFile(f.path)}
                  aria-label={`删除 ${f.path}`}
                >
                  ✕
                </button>
              </div>
            ))}
            {files && fileList.length === 0 && (
              <div style={{ color: 'var(--muted)', padding: 10, fontSize: 12.5 }}>暂无文件</div>
            )}
          </div>
          <div className="editor-side-head" style={{ borderTop: '1px solid var(--border)' }}>
            <span>💾 提交到 develop</span>
          </div>
          <div className="commit-box">
            <input
              className="input"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="提交说明"
              aria-label="提交说明"
            />
            <div className="commit-actions">
              <button className="btn btn-sm" onClick={commit} disabled={!!busy}>
                提交
              </button>
              <button className="btn btn-primary btn-sm" onClick={publish} disabled={!!busy}>
                🚀 发布
              </button>
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.7 }}>
              发布 = 推送 main 分支: 触发自动构建(构建与提交绑定)。构建成功才会公开展示;
              构建失败可在详情页看日志并重新构建。
            </div>
          </div>
        </aside>

        <div className="editor-main">
          {current ? (
            <MonacoEditor
              height="100%"
              language={langOf(current)}
              theme={editorTheme}
              value={content}
              onChange={(v?: string) => {
                setContent(v || '');
                setDirty(true);
              }}
              onMount={handleMount}
              options={{
                fontSize: 13,
                tabSize: 2,
                minimap: { enabled: false },
                automaticLayout: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
              }}
            />
          ) : (
            <div className="editor-placeholder">从左侧选择文件开始编辑 · Ctrl/Cmd+S 保存</div>
          )}
        </div>
      </div>

      {/* 底部构建日志 */}
      {showLog && <pre className="editor-log">{work.buildLog || '（暂无构建日志）'}</pre>}
      {dirty && (
        <div className="alert info" style={{ borderRadius: 0, margin: 0 }}>
          ⚠ 有未保存的改动(Ctrl/Cmd+S 保存)
        </div>
      )}
    </div>
  );
}
