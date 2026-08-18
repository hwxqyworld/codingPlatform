// ============================================================
//  作品模板 —— SDL2 + Emscripten
//
//  一个简单的小演示: 方向键移动方块, 空格随机变色, ESC 退出。
//  编译参数见 compile.json(平台会自动执行 emcc 构建)。
//
//  编写作品的要点:
//    1. 用 emscripten_set_main_loop 驱动帧循环(不要用 while 死循环,
//       否则会阻塞浏览器页面);
//    2. 图片/音频等资源放在 assets/ 目录, 编译时会自动预加载进
//       虚拟文件系统, 代码里直接用相对路径读取即可;
//    3. 修改代码后: 提交到 develop(内部), 推送 main 即公开并计一次更新。
// ============================================================
#include <SDL2/SDL.h>
#include <emscripten/emscripten.h>
#include <cstdlib>

// 窗口逻辑尺寸(渲染器会自动缩放适配浏览器画布)
static const int WINDOW_W = 640;
static const int WINDOW_H = 480;

// 游戏全局状态
struct Game {
  SDL_Window*   window   = nullptr;
  SDL_Renderer* renderer = nullptr;
  SDL_Rect      player   = { WINDOW_W / 2 - 20, WINDOW_H / 2 - 20, 40, 40 };
  SDL_Color     color    = { 64, 196, 255, 255 };
  int           speed    = 5;
  bool          running  = true;
};

static Game g;

// 每帧回调 —— 由 emscripten_set_main_loop 驱动(等价于浏览器 rAF)
void frame() {
  // 处理事件
  SDL_Event ev;
  while (SDL_PollEvent(&ev)) {
    if (ev.type == SDL_QUIT) g.running = false;
    if (ev.type == SDL_KEYDOWN) {
      if (ev.key.keysym.sym == SDLK_ESCAPE) g.running = false;
      if (ev.key.keysym.sym == SDLK_SPACE) {
        // 随机换色
        g.color = { (Uint8)(rand() % 256), (Uint8)(rand() % 256), (Uint8)(rand() % 256), 255 };
      }
    }
  }

  // 方向键移动(读取按键状态, 支持长按)
  const Uint8* keys = SDL_GetKeyboardState(nullptr);
  if (keys[SDL_SCANCODE_LEFT])  g.player.x -= g.speed;
  if (keys[SDL_SCANCODE_RIGHT]) g.player.x += g.speed;
  if (keys[SDL_SCANCODE_UP])    g.player.y -= g.speed;
  if (keys[SDL_SCANCODE_DOWN])  g.player.y += g.speed;

  // 边界约束
  if (g.player.x < 0) g.player.x = 0;
  if (g.player.y < 0) g.player.y = 0;
  if (g.player.x + g.player.w > WINDOW_W) g.player.x = WINDOW_W - g.player.w;
  if (g.player.y + g.player.h > WINDOW_H) g.player.y = WINDOW_H - g.player.h;

  // 绘制一帧
  SDL_SetRenderDrawColor(g.renderer, 18, 22, 32, 255);
  SDL_RenderClear(g.renderer);
  SDL_SetRenderDrawColor(g.renderer, g.color.r, g.color.g, g.color.b, g.color.a);
  SDL_RenderFillRect(g.renderer, &g.player);
  SDL_RenderPresent(g.renderer);
}

int main() {
  if (SDL_Init(SDL_INIT_VIDEO) < 0) return -1;

  g.window = SDL_CreateWindow(
    "SDL2 Demo",
    SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
    WINDOW_W, WINDOW_H, SDL_WINDOW_SHOWN);
  if (!g.window) return -1;

  g.renderer = SDL_CreateRenderer(g.window, -1, SDL_RENDERER_ACCELERATED);
  if (!g.renderer) return -1;
  SDL_RenderSetLogicalSize(g.renderer, WINDOW_W, WINDOW_H);

  // 用浏览器事件循环驱动帧更新(最后一个参数 1 = 模拟无限循环, main 不退出)
  emscripten_set_main_loop(frame, 0, 1);
  return 0;
}
