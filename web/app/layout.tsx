import type { Metadata, Viewport } from 'next';
import './globals.css';
import { PUBLIC_URL } from '@/lib/env';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/components/ThemeProvider';
import TopBar from '@/components/TopBar';
import Footer from '@/components/Footer';

const SITE_NAME = '创玩 · C++ 创作平台';

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_URL),
  title: {
    default: `${SITE_NAME} — 用 C++/SDL2 创作, 浏览器即玩`,
    template: `%s · 创玩`,
  },
  description:
    '创玩是一个本地部署的 C++ 创作平台: 用 C++/SDL2 写作品, Emscripten 编译成 WebAssembly, 任何人都能在浏览器里直接游玩。支持在线编辑器与 git 双创作方式, 人人平等曝光。',
  keywords: ['C++', 'SDL2', 'Emscripten', 'WebAssembly', '在线编辑器', '创作平台', '浏览器游戏'],
  applicationName: '创玩',
  authors: [{ name: '创玩社区' }],
  creator: '创玩',
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    locale: 'zh_CN',
    url: PUBLIC_URL,
    title: SITE_NAME,
    description: '用 C++/SDL2 创作游戏, Emscripten 编译为 WebAssembly, 浏览器直接游玩。',
  },
  twitter: {
    card: 'summary',
    title: SITE_NAME,
    description: '用 C++/SDL2 创作游戏, 浏览器直接游玩。',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  icons: {
    icon: '/favicon.svg',
    apple: '/favicon.svg',
  },
  manifest: '/manifest.webmanifest',
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#4f46e5' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1120' },
  ],
};

/** 首屏主题初始化(避免暗色模式闪烁); 与 ThemeProvider 的键保持一致 */
const THEME_INIT = `(function(){try{var k='cppplay-theme',s=localStorage.getItem(k);if(s!=='light'&&s!=='dark'){s=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=s;}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <a className="skip-link" href="#main">
              跳到主要内容
            </a>
            <TopBar />
            <main id="main">{children}</main>
            <Footer />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
