'use client';

/** 页面级错误边界: 展示可读错误并允许重试 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page">
      <div className="empty">
        <h2 style={{ margin: '0 0 8px' }}>页面加载失败</h2>
        <p style={{ margin: '0 0 18px', color: 'var(--muted)' }}>{error.message || '未知错误'}</p>
        <button className="btn btn-primary" onClick={reset}>
          重试
        </button>
      </div>
    </div>
  );
}
