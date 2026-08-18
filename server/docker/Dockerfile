# ============================================================
# cpp-builder —— 平台构建容器镜像
#
# 安全模型:
#   - 运行期容器一律 --network none, 所有依赖(SDL 端口、系统库)
#     必须在镜像构建期全部预下载/预编译进缓存 —— 离线构建的关键
#   - 每个构建任务使用独立缓存副本(/opt/pristine-cache 拷贝),
#     任务间零共享可变状态, 恶意构建无法污染后续构建
#   - 容器内以非特权用户(builder)运行用户代码, 无任何宿主机挂载
#
# 构建(在仓库根目录执行):
#   docker build -f server/docker/Dockerfile -t cpp-builder .
# 或直接运行: server/docker/build-image.sh
# ============================================================
FROM emscripten/emsdk:latest

# git: 平台侧 git 操作在容器内执行; 构建任务在容器内导出快照
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 预构建 SDL 端口 + 常用优化级别(-O2 与平台默认编译参数一致)的系统库:
#   -sUSE_SDL=2 / SDL_IMAGE / SDL_TTF / SDL_MIXER 触发端口下载+编译
#   端口源码与编译产物都进入 emscripten 缓存, 运行期离线也能命中
RUN mkdir -p /tmp/sdl-probe \
 && printf '#include <SDL2/SDL.h>\nint main(){return 0;}\n' > /tmp/sdl-probe/probe.c \
 && cd /tmp/sdl-probe \
 && emcc probe.c -o probe.js -O2 \
      -sUSE_SDL=2 \
      -sUSE_SDL_IMAGE=2 -sSDL2_IMAGE_FORMATS=png,jpg,bmp,gif \
      -sUSE_SDL_TTF=2 \
      -sUSE_SDL_MIXER=2 \
 && rm -rf /tmp/sdl-probe

# 固化缓存副本: 每个构建任务从该副本拷贝独立缓存(EM_CACHE 取镜像内定义值)
RUN CACHE_DIR="$(em-config CACHE 2>/dev/null || true)"; \
    [ -n "$CACHE_DIR" ] || CACHE_DIR="$HOME/.emscripten_cache"; \
    mkdir -p /opt/pristine-cache && \
    cp -a "$CACHE_DIR/." /opt/pristine-cache/ && \
    chmod -R a+rX /opt/pristine-cache

# 平台构建脚本与作品外壳
COPY server/docker/build.js /opt/platform/build.js
COPY server/src/shell.html /opt/platform/shell.html

# 非特权构建用户(容器内运行用户代码的进程; 容器无宿主机挂载, 权限不与宿主机冲突)
RUN useradd -m -u 1000 builder \
 && mkdir -p /work \
 && chown builder:builder /work

USER builder
WORKDIR /work
ENV HOME=/home/builder
CMD ["sleep", "infinity"]
