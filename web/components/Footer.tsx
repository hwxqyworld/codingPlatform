/** 页脚: 平台规则说明(服务端组件, 无需交互) */
export default function Footer() {
  return (
    <footer className="footer">
      <div>⚙ 创玩 · C++ 创作平台 — 用 C++/SDL2 创作, Emscripten 编译, 浏览器即玩</div>
      <div className="footer-rules">
        <span>main 分支构建成功的作品才会公开</span>
        <span>主页只按最近更新时间排序, 人人平等曝光</span>
      </div>
    </footer>
  );
}
