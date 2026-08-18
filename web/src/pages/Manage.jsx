import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, fmtTime } from '../api.js';
import { useAuth } from '../App.jsx';

/**
 * 创作管理页: 我的作品列表(含草稿) + 创建作品 + git 使用说明。
 */
export default function Manage() {
  const { creator, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [works, setWorks] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState('');
  const [gitWork, setGitWork] = useState(null); // git 说明弹窗
  const [gitInfo, setGitInfo] = useState(null);
  const [toolchain, setToolchain] = useState(null); // 构建工具链状态

  useEffect(() => {
    api
      .toolchain()
      .then(setToolchain)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!creator) {
      navigate('/login', { state: { from: location.pathname } });
      return;
    }
    api
      .me()
      .then((d) => setWorks(d.works))
      .catch((e) => setMsg(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creator]);

  /** 创建作品 -> 跳转到在线编辑器 */
  const create = async () => {
    if (!title.trim()) {
      setMsg('请填写作品标题');
      return;
    }
    setCreating(true);
    setMsg('');
    try {
      const d = await api.createWork({ title, description });
      navigate(`/edit/${d.work.id}`);
    } catch (e) {
      setMsg(e.message);
      setCreating(false);
    }
  };

  const remove = async (w) => {
    if (!window.confirm(`确定删除作品「${w.title}」吗? 源码仓库将一并删除, 不可恢复。`)) return;
    try {
      await api.deleteWork(w.id);
      setWorks((ws) => ws.filter((x) => x.id !== w.id));
      setMsg('已删除');
    } catch (e) {
      setMsg(e.message);
    }
  };

  /** 打开 git 说明弹窗 */
  const showGit = async (w) => {
    setGitWork(w);
    setGitInfo(null);
    try {
      const d = await api.gitInfo(w.id);
      setGitInfo(d);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const statusMap = {
    none: ['私有', 'muted'],
    queued: ['排队中', 'yellow'],
    building: ['构建中', 'yellow'],
    success: ['已发布', 'green'],
    failed: ['构建失败', 'red'],
  };

  return (
    <div className="page">
      <div className="banner">
        <h1>创作管理</h1>
        <p>
          创作者: {creator} ·{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              logout();
              navigate('/');
            }}
          >
            退出登录
          </a>
        </p>
      </div>

      {msg && <div className="alert info">{msg}</div>}

      {/* 构建工具链状态(安装入口) */}
      {toolchain && (
        <div
          className="alert"
          style={{
            ...(toolchain.ok
              ? { background: 'rgba(63,185,80,0.1)', border: '1px solid rgba(63,185,80,0.35)', color: 'var(--green)' }
              : {}),
            whiteSpace: 'pre-wrap',
          }}
        >
          {toolchain.ok ? (
            toolchain.mode === 'container' ? (
              <>✓ 容器构建已就绪({toolchain.version}) — 发布作品即可自动构建(安全隔离模式)</>
            ) : (
              <>✓ Emscripten 工具链已就绪(emcc {toolchain.version}) — 发布作品即可自动构建</>
            )
          ) : (
            <>
              <strong>⚠ 未检测到 Emscripten 工具链(emcc)</strong>，作品暂时无法编译。安装入口：
              {`\n`}{toolchain.hint}
            </>
          )}
        </div>
      )}

      {/* 创建作品 */}
      <div className="form" style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20 }}>
        <h3 style={{ margin: 0 }}>创建新作品</h3>
        <div className="field">
          <label>标题 *</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如: 像素跑酷" />
        </div>
        <div className="field">
          <label>简介</label>
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话介绍你的作品" />
        </div>
        <div>
          <button className="btn btn-primary" onClick={create} disabled={creating || !title.trim()}>
            {creating ? '创建中…' : '创建并打开编辑器'}
          </button>
          <span style={{ color: 'var(--muted)', fontSize: 12.5, marginLeft: 12 }}>
            将自动初始化 git 仓库, 内置 SDL2 模板
          </span>
        </div>
      </div>

      {/* 我的作品 */}
      <h3 style={{ margin: 0 }}>我的作品</h3>
      {!works && <div className="empty">加载中…</div>}
      {works && works.length === 0 && <div className="empty">还没有作品, 从上方创建一个吧</div>}
      <div className="works-table">
        {works?.map((w) => {
          const [label, cls] = statusMap[w.buildStatus] || statusMap.none;
          return (
            <div className="work-row" key={w.id}>
              <div className="info">
                <div className="t">
                  {w.title}
                  <span className={`badge ${cls}`} style={{ marginLeft: 10 }}>{label}</span>
                </div>
                <div className="d">
                  创建于 {fmtTime(w.createdAt)} · 最近更新 {fmtTime(w.lastUpdate)}
                </div>
              </div>
              <div className="actions">
                <Link className="btn btn-sm" to={`/edit/${w.id}`}>✏ 编辑</Link>
                {w.publishedSha && <Link className="btn btn-sm" to={`/work/${w.id}`}>▶ 作品页</Link>}
                <button className="btn btn-sm" onClick={() => showGit(w)}>git 说明</button>
                <button className="btn btn-sm btn-danger" onClick={() => remove(w)}>删除</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* git 使用说明弹窗 */}
      {gitWork && (
        <div className="modal-mask" onClick={() => setGitWork(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>git 方式更新「{gitWork.title}」</h3>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
              平台采用 develop / main 双分支(新作品自动初始化): develop 内部使用;
              main 被推送即触发自动构建, 构建成功才会公开展示。
            </p>
            {gitInfo ? (
              <pre className="git-cmd">{`# 1. 首次使用: 克隆仓库(或把已有仓库关联到远程)
git clone ${gitInfo.remote}
cd ${gitWork.id}

# 2. 日常开发: 推送到 develop(内部, 不会公开)
git add -A && git commit -m "开发中"
git push origin develop

# 3. 发布: 推送 main(触发自动构建; 构建成功才会公开展示)
git push origin develop:main

# 提示: 构建状态与日志在作品页/编辑器查看; 构建失败可一键重新构建
#       最近一次提交构建失败时, 作品页运行最近一次有效构建`}</pre>
            ) : (
              <div className="empty">加载中…</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setGitWork(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
