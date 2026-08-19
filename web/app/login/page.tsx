'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

type Mode = 'login' | 'register';

/**
 * 登录 / 注册页 —— 对接后端账号系统:
 *   登录: 用户名或已验证邮箱 + 密码
 *   注册: 用户名 + 密码 + 邮箱; 未配置 SMTP 时(开发模式)直接展示验证令牌,
 *        也可输入邮箱收到的验证码完成验证。
 */
export default function LoginPage() {
  const { setSession } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');

  // 登录
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  // 注册
  const [username, setUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [email, setEmail] = useState('');
  const [verifyToken, setVerifyToken] = useState('');

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account.trim() || !password || busy) return;
    setBusy(true);
    setMsg('');
    setOk(false);
    try {
      const d = await api.login(account.trim(), password);
      setSession({ name: d.name, token: d.token });
      router.push('/manage');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || regPassword.length < 8 || !email.trim() || busy) return;
    setBusy(true);
    setMsg('');
    setOk(false);
    try {
      const d = await api.register(username.trim(), regPassword, email.trim());
      if (d.needsVerify) {
        setOk(true);
        setMsg(
          d.verificationToken
            ? '注册成功! 平台未配置邮件服务(开发模式), 请使用下方验证令牌完成邮箱验证:'
            : '注册成功! 验证邮件已发送, 请查收邮件中的验证令牌并填入下方。',
        );
        setVerifyToken(d.verificationToken || '');
      } else {
        setOk(true);
        setMsg('注册成功, 请登录。');
        setMode('login');
        setAccount(username.trim());
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifyToken.trim() || busy) return;
    setBusy(true);
    setMsg('');
    setOk(false);
    try {
      const d = await api.verify(verifyToken.trim());
      setOk(true);
      setMsg(`邮箱 ${d.email} 验证成功! 现在可以用密码登录了。`);
      setMode('login');
      setAccount(username || d.name);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const regValid = username.trim().length > 0 && regPassword.length >= 8 && email.includes('@');

  return (
    <div className="page">
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-logo" aria-hidden="true">
            ⚙
          </div>
          <h2>欢迎来到创玩</h2>
          <p className="auth-sub">用 C++/SDL2 创作, 浏览器即玩</p>

          <div className="auth-tabs" role="tablist" aria-label="登录或注册">
            <button
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'active' : ''}
              onClick={() => {
                setMode('login');
                setMsg('');
                setOk(false);
              }}
            >
              登录
            </button>
            <button
              role="tab"
              aria-selected={mode === 'register'}
              className={mode === 'register' ? 'active' : ''}
              onClick={() => {
                setMode('register');
                setMsg('');
                setOk(false);
              }}
            >
              注册
            </button>
          </div>

          {mode === 'login' ? (
            <form onSubmit={submitLogin}>
              <div className="field">
                <label htmlFor="account">用户名 / 邮箱</label>
                <input
                  id="account"
                  className="input"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  placeholder="你的用户名或已验证邮箱"
                  maxLength={64}
                  autoFocus
                  autoComplete="username"
                />
              </div>
              <div className="field">
                <label htmlFor="password">密码</label>
                <input
                  id="password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入密码"
                  autoComplete="current-password"
                />
              </div>
              {msg && (
                <div className={`alert ${ok ? 'success' : 'error'}`} role="status">
                  {msg}
                </div>
              )}
              <button
                className="btn btn-primary"
                type="submit"
                disabled={busy || !account.trim() || !password}
                style={{ width: '100%' }}
              >
                {busy ? '登录中…' : '登录'}
              </button>
              <p className="tip">登录后即可创建作品、使用在线编辑器或 git 命令行方式开发。</p>
            </form>
          ) : (
            <div>
              <form onSubmit={submitRegister}>
                <div className="field">
                  <label htmlFor="username">用户名 *</label>
                  <input
                    id="username"
                    className="input"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="1-32 位, 中文/字母/数字/下划线/连字符"
                    maxLength={32}
                    autoFocus
                    autoComplete="username"
                  />
                </div>
                <div className="field">
                  <label htmlFor="regPassword">密码 *</label>
                  <input
                    id="regPassword"
                    className="input"
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="至少 8 位"
                    autoComplete="new-password"
                  />
                </div>
                <div className="field">
                  <label htmlFor="email">邮箱 *</label>
                  <input
                    id="email"
                    className="input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="用于验证与找回账号"
                    autoComplete="email"
                  />
                </div>
                {msg && (
                  <div className={`alert ${ok ? 'success' : 'error'}`} role="status">
                    {msg}
                    {ok && verifyToken && (
                      <div style={{ marginTop: 8 }}>
                        <code
                          style={{
                            wordBreak: 'break-all',
                            fontSize: 13,
                            background: 'var(--panel)',
                            padding: '6px 10px',
                            borderRadius: 8,
                            display: 'inline-block',
                          }}
                        >
                          {verifyToken}
                        </code>
                      </div>
                    )}
                  </div>
                )}
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={busy || !regValid}
                  style={{ width: '100%' }}
                >
                  {busy ? '注册中…' : '注册并发送验证'}
                </button>
              </form>

              {/* 邮箱验证 */}
              <form onSubmit={submitVerify} style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed var(--border)' }}>
                <div className="field">
                  <label htmlFor="verifyToken">邮箱验证令牌</label>
                  <input
                    id="verifyToken"
                    className="input"
                    value={verifyToken}
                    onChange={(e) => setVerifyToken(e.target.value)}
                    placeholder="粘贴邮件中的验证令牌"
                  />
                </div>
                <button
                  className="btn"
                  type="submit"
                  disabled={busy || !verifyToken.trim()}
                  style={{ width: '100%' }}
                >
                  完成验证
                </button>
              </form>

              <p className="tip">
                邮箱验证通过后账号才可登录。若未收到邮件, 请检查服务端控制台(开发模式)或 SMTP 配置。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
