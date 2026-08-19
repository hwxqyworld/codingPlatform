'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { clearSession, getCreatorName, getToken, saveSession } from './api';

interface AuthValue {
  /** 已登录创作者名(空串 = 未登录) */
  creator: string;
  token: string;
  /** 客户端是否已从 localStorage 恢复会话(服务端恒为 false) */
  ready: boolean;
  setSession: (s: { token: string; name: string }) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}

/**
 * 登录上下文: 全局共享创作者身份(token + 名称, 持久化在 localStorage)。
 * 同步监听 storage 事件, 多标签页登录/退出即时生效。
 * 注意: 服务端渲染时始终渲染 children(ready 状态只影响客户端),
 * 避免 SSR 输出空页面损害 SEO; 登录态闪烁由 TopBar 自行处理。
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [creator, setCreator] = useState('');
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setCreator(getCreatorName());
    setToken(getToken());
    setReady(true);
    const onStorage = () => {
      setCreator(getCreatorName());
      setToken(getToken());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value: AuthValue = {
    creator,
    token,
    ready,
    setSession: useCallback((session) => {
      saveSession(session);
      setCreator(session.name);
      setToken(session.token);
    }, []),
    logout: useCallback(() => {
      clearSession();
      setCreator('');
      setToken('');
    }, []),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
