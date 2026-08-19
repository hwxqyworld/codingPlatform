'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/components/ThemeProvider';

const NAV = [
  { href: '/', label: '主页', exact: true },
  { href: '/all', label: '全部作品' },
  { href: '/manage', label: '创作管理' },
];

/**
 * 顶栏: 品牌 + 导航 + 主题切换 + 登录态。
 * 移动端折叠为抽屉菜单。
 */
export default function TopBar() {
  const { creator, ready } = useAuth();
  const { theme, toggle } = useTheme();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // localStorage 在挂载后才可读: 挂载前不显示登录态区, 避免闪烁
  useEffect(() => {
    setMounted(true);
  }, []);

  const showAuth = mounted && ready;

  // 路由变化时关闭移动端菜单
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const isActive = (item: (typeof NAV)[number]) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  const navItems = NAV.map((item) => (
    <Link
      key={item.href}
      href={item.href}
      className={isActive(item) ? 'active' : ''}
      aria-current={isActive(item) ? 'page' : undefined}
    >
      {item.label}
    </Link>
  ));

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" aria-label="创玩首页">
          <span className="brand-logo" aria-hidden="true">
            ⚙
          </span>
          创玩
        </Link>
        <nav aria-label="主导航">{navItems}</nav>
        <div className="topbar-user">
          <button
            type="button"
            className="icon-btn"
            onClick={toggle}
            aria-label={theme === 'dark' ? '切换到明亮模式' : '切换到暗色模式'}
            title={theme === 'dark' ? '切换到明亮模式' : '切换到暗色模式'}
          >
            {theme === 'dark' ? '☀' : '🌙'}
          </button>
          {showAuth &&
            (creator ? (
              <Link href="/manage" className="chip" title={`当前创作者: ${creator}`}>
                👤 {creator}
              </Link>
            ) : (
              <Link className="btn btn-primary btn-sm" href="/login">
                登录
              </Link>
            ))}
          <button
            type="button"
            className="icon-btn menu-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-label="打开菜单"
            aria-expanded={open}
          >
            ☰
          </button>
        </div>
      </header>
      <nav className={`mobile-drawer${open ? ' open' : ''}`} aria-label="移动端导航">
        {navItems}
      </nav>
    </>
  );
}
