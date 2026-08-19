'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtTime, statusOf } from '@/lib/format';
import type { GitInfo, OwnUser, ToolchainInfo, Work } from '@/lib/types';

/**
 * 创作管理页: 账号资料 + 我的作品(含草稿) + 创建作品 + git 使用说明。
 * 需登录; 未登录自动跳转登录页。
 */
export default function ManagePage() {
  const { creator, token, ready, logout, setSession } = useAuth();
  const router = useRouter();

  const [user, setUser] = useState<OwnUser | null>(null);
  const [works, setWorks] = useState<Work[] | null>(null);
  const [toolchain, setToolchain] = useState<ToolchainInfo | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState('');

  // git 说明弹窗
  const [gitWork, setGitWork] = useState<Work | null>(null);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);

  // 资料编辑
  const [nickname, setNickname] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('');
  // 修改密码
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');

  const load = useCallback(async () => {
    const d = await api.me();
    setUser(d.user);
    setWorks(d.works);
    setNickname(d.user.nickname);
    setBio(d.user.bio);
    setAvatar(d.user.avatar);
  }, []);

  useEffect(() => {
    api
      .toolchain()
      .then((d) => setToolchain(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!ready) return; // 等待客户端会话恢复, 避免误跳登录页
    if (!token) {
      router.replace('/login');
      return;
    }
    load().catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  }, [token, ready, router, load]);

  const create = async () => {
    if (!title.trim() || creating) return;
    setCreating(true);
    setMsg('');
    try {
      const d = await api.createWork({ title, description });
      router.push(`/edit/${d.work.id}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setCreating(false);
    }
  };

  const remove = async (w: Work) => {
    if (!window.confirm(`确定删除作品「${w.title}」吗? 源码仓库将一并删除, 不可恢复。`)) return;
    try {
      await api.deleteWork(w.id);
      setWorks((ws) => (ws || []).filter((x) => x.id !== w.id));
      setMsg('已删除');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const showGit = async (w: Work) => {
    setGitWork(w);
    setGitInfo(null);
    try {
      const d = await api.gitInfo(w.id);
      setGitInfo(d);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const saveProfile = async () => {
    setMsg('');
    try {
      await api.updateProfile({ nickname: nickname.trim(), bio: bio.trim(), avatar: avatar.trim() });
      setMsg('✓ 资料已更新');
      load().catch(() => {});
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const changePassword = async () => {
    setMsg('');
    try {
      const d = await api.changePassword(oldPw, newPw);
      setMsg('✓ 密码已修改, 请重新登录');
      if (d.token) {
        // 后端轮换了会话令牌, 直接续用新令牌, 无需重新登录
        setSession({ token: d.token, name: creator });
      } else {
        logout();
        router.replace('/login');
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  if (!ready || !token || !creator) return null; // 会话恢复中或未登录 -> 上面的 effect 会处理重定向

  return (
    <div className="page">
      <div className="section-head">
        <h1 style={{ margin: 0, fontSize: 24 }}>创作管理</h1>
        <button
          className="btn btn-ghost btn-sm section-more"
          onClick={() => {
            logout();
            router.replace('/');
          }}
        >
          退出登录
        </button>
      </div>

      {msg && <div className={`alert ${msg.startsWith('✓') ? 'success' : 'info'}`}>{msg}</div>}

      {/* 构建工具链状态 */}
      {toolchain && (
        <div
          className={`alert ${toolchain.ok ? 'success' : 'error'}`}
          style={{ margin: '12px 0', whiteSpace: 'pre-wrap' }}
        >
          {toolchain.ok
            ? toolchain.mode === 'container'
              ? `✓ 容器构建已就绪(${toolchain.version}) — 发布作品即可自动构建(安全隔离模式)`
              : `✓ Emscripten 工具链已就绪(emcc ${toolchain.version}) — 发布作品即可自动构建`
            : `⚠ 未检测到 Emscripten 工具链(emcc), 作品暂时无法编译。安装入口:\n${toolchain.hint || ''}`}
        </div>
      )}

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', marginBottom: 24 }}>
        {/* 创建作品 */}
        <div className="form">
          <h3>创建新作品</h3>
          <div className="field">
            <label htmlFor="new-title">标题 *</label>
            <input
              id="new-title"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如: 像素跑酷"
              maxLength={60}
            />
          </div>
          <div className="field">
            <label htmlFor="new-desc">简介</label>
            <textarea
              id="new-desc"
              className="textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话介绍你的作品"
              maxLength={200}
            />
          </div>
          <div>
            <button className="btn btn-primary" onClick={create} disabled={creating || !title.trim()}>
              {creating ? '创建中…' : '创建并打开编辑器'}
            </button>
            <span style={{ color: 'var(--muted)', fontSize: 12.5, marginLeft: 12 }}>
              自动初始化 git 仓库, 内置 SDL2 模板
            </span>
          </div>
        </div>

        {/* 账号资料 */}
        {user && (
          <div className="form">
            <h3>账号资料</h3>
            <div className="field">
              <label htmlFor="nickname">昵称</label>
              <input
                id="nickname"
                className="input"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={24}
              />
            </div>
            <div className="field">
              <label htmlFor="bio">简介</label>
              <textarea
                id="bio"
                className="textarea"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="展示在个人主页"
                maxLength={200}
              />
            </div>
            <div className="field">
              <label htmlFor="avatar">头像(emoji)</label>
              <input
                id="avatar"
                className="input"
                value={avatar}
                onChange={(e) => setAvatar(e.target.value)}
                placeholder="如 🚀 (最多 8 字符)"
                maxLength={8}
              />
            </div>
            <button className="btn" onClick={saveProfile}>
              保存资料
            </button>
            {user.hasPassword && (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px dashed var(--border)' }}>
                <div className="field">
                  <label htmlFor="old-pw">当前密码</label>
                  <input
                    id="old-pw"
                    className="input"
                    type="password"
                    value={oldPw}
                    onChange={(e) => setOldPw(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
                <div className="field">
                  <label htmlFor="new-pw">新密码</label>
                  <input
                    id="new-pw"
                    className="input"
                    type="password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    placeholder="至少 8 位"
                    autoComplete="new-password"
                  />
                </div>
                <button
                  className="btn btn-sm"
                  onClick={changePassword}
                  disabled={!oldPw || newPw.length < 8}
                >
                  修改密码
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 我的作品 */}
      <div className="section-head">
        <h2>我的作品</h2>
      </div>
      {!works && <div className="empty">加载中…</div>}
      {works && works.length === 0 && <div className="empty">还没有作品, 从上方创建一个吧</div>}
      <div className="works-table">
        {works?.map((w) => {
          const [label, cls] = statusOf(w.buildStatus);
          return (
            <div className="work-row" key={w.id}>
              <div className="info">
                <div className="t">
                  {w.title}
                  <span className={`badge ${cls}`}>{label}</span>
                </div>
                <div className="d">
                  创建于 {fmtTime(w.createdAt)} · 最近更新 {fmtTime(w.lastUpdate)}
                </div>
              </div>
              <div className="actions">
                <Link className="btn btn-sm" href={`/edit/${w.id}`}>
                  ✏ 编辑
                </Link>
                {w.publishedSha && (
                  <Link className="btn btn-sm" href={`/work/${w.id}`}>
                    ▶ 作品页
                  </Link>
                )}
                <button className="btn btn-sm" onClick={() => showGit(w)}>
                  git 说明
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => remove(w)}>
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* git 使用说明弹窗 */}
      {gitWork && (
        <div className="modal-mask" onClick={() => setGitWork(null)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`git 方式更新 ${gitWork.title}`}
          >
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

# 认证: 用户名 ${gitInfo.auth.username} / 密码 = 平台账号密码
# 提示: 构建状态与日志在作品页/编辑器查看; 构建失败可一键重新构建
#       最近一次提交构建失败时, 作品页运行最近一次有效构建`}</pre>
            ) : (
              <div className="empty">加载中…</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setGitWork(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
