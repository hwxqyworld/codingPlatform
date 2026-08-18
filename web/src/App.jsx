import { createContext, useContext, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import Home from './pages/Home.jsx';
import AllWorks from './pages/AllWorks.jsx';
import WorkDetail from './pages/WorkDetail.jsx';
import EditorPage from './pages/Editor.jsx';
import Manage from './pages/Manage.jsx';
import Login from './pages/Login.jsx';
import { clearSession, getCreatorName, getToken, saveSession } from './api.js';

/**
 * 登录上下文: 全局共享创作者身份(名称 + token, 持久化在 localStorage)。
 */
export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export default function App() {
  const [creator, setCreator] = useState(getCreatorName());
  const [token, setToken] = useState(getToken());

  const value = {
    creator,
    token,
    /** 登录成功后写入会话 */
    setSession(session) {
      saveSession(session);
      setCreator(session.name);
      setToken(session.token);
    },
    logout() {
      clearSession();
      setCreator('');
      setToken('');
    },
  };

  return (
    <AuthContext.Provider value={value}>
      <div className="app">
        <header className="topbar">
          <Link to="/" className="brand">⚙ C++ 编程平台</Link>
          <nav>
            <NavLink to="/" end>主页</NavLink>
            <NavLink to="/all">全部作品</NavLink>
            <NavLink to="/manage">创作管理</NavLink>
          </nav>
          <div className="topbar-user">
            {creator ? (
              <span className="chip" title="当前创作者">{creator}</span>
            ) : (
              <Link className="btn btn-primary btn-sm" to="/login">登录</Link>
            )}
          </div>
        </header>

        <main className="main">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/all" element={<AllWorks />} />
            <Route path="/work/:id" element={<WorkDetail />} />
            <Route path="/edit/:id" element={<EditorPage />} />
            <Route path="/manage" element={<Manage />} />
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<div className="empty">页面不存在</div>} />
          </Routes>
        </main>

        <footer className="footer">
          main 分支构建成功的作品才会公开 · 主页只按最近更新时间排序, 人人平等曝光
        </footer>
      </div>
    </AuthContext.Provider>
  );
}
