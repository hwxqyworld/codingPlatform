import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

/**
 * 登录页 —— 极简身份: 输入创作者名称即登录(平台本地化设计, 无密码)。
 */
export default function Login() {
  const { setSession } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const location = useLocation();
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const d = await api.login(name);
      setSession(d);
      navigate(location.state?.from || '/manage', { replace: true });
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login-wrap" onSubmit={submit}>
      <h2>👋 欢迎来到 C++ 编程平台</h2>
      <div className="field">
        <label>创作者名称</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="输入一个名字即可开始创作"
          maxLength={32}
          autoFocus
        />
      </div>
      {msg && <div className="alert error">{msg}</div>}
      <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
        {busy ? '登录中…' : '进入平台'}
      </button>
      <p className="tip">
        平台为本地部署设计, 名称即身份。登录后即可创建作品、
        使用在线编辑器(类 VSCode)或 git 命令行方式开发。
      </p>
    </form>
  );
}
