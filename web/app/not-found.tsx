import Link from 'next/link';

/** 404 页 */
export default function NotFound() {
  return (
    <div className="not-found">
      <div className="nf-code">404</div>
      <h1>页面不存在</h1>
      <p>你要找的页面可能已删除、尚未发布, 或者链接有误。</p>
      <Link className="btn btn-primary" href="/">
        返回主页
      </Link>
    </div>
  );
}
