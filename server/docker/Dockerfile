# ============================================================
# cppplay-builder —— 平台构建容器镜像
#
# 安全模型:
#   - 运行期容器一律 --network none, 所有依赖(SDL 端口、系统库)
#     必须在镜像构建期全部预下载/预编译进缓存 —— 离线构建的关键
#   - 每个构建任务使用独立缓存副本(/opt/pristine-cache 拷贝),
#     任务间零共享可变状态, 恶意构建无法污染后续构建
#   - 容器内以非特权用户(UID 1000)运行用户代码, 无任何宿主机挂载
#
# 用户策略(不硬编码用户名):
#   - 基础镜像的 UID 1000 用户名随版本变化(emscripten → ubuntu → ...),
#     因此构建期"自动选取 UID 1000 用户, 不存在则创建", 运行期一律
#     以数字 UID 引用(USER 1000 / docker exec -u 1000 / chown 1000:1000),
#     彻底规避 "unable to find user xxx" 类错误。
#
# 构建(在仓库根目录执行):
#   docker build -f server/docker/Dockerfile -t cppplay-builder .
# 或直接运行: server/docker/build-image.sh
# ============================================================
FROM docker.1ms.run/emscripten/emsdk:latest

# git: 平台侧 git 操作在容器内执行; 构建任务在容器内导出快照
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# —— emscripten 环境(镜像构建期固化) ——
# 基础镜像已内置 EMSDK=/emsdk 与 PATH(emcc/node), 但其 entrypoint 只在
# docker run 时 source emsdk_env.sh —— 平台运行期经 docker exec 执行命令,
# 不经过 entrypoint 且容器无网络, 因此这里把 .emscripten 配置固化到镜像 ENV,
# 保证任意 HOME / 任意用户下 emcc 行为一致(缓存仍由平台按任务用 EM_CACHE 覆盖)。
# 官方镜像构建期已通过 `emsdk activate` 生成 /emsdk/.emscripten(配置位于 emsdk 目录);
# 若缺失则回退重新 activate 或按官方布局手动生成一份兜底。
RUN if [ ! -f /emsdk/.emscripten ]; then \
      if cd /emsdk && EMSDK_QUIET=1 ./emsdk activate "$(cat /emsdk/.active 2>/dev/null || echo latest)" >/dev/null 2>&1; then \
        :; \
      else \
        printf 'import os\nemsdk_path = "/emsdk"\nos.environ["EMSDK"] = emsdk_path\nLLVM_ROOT = emsdk_path + "/upstream/bin"\nBINARYEN_ROOT = emsdk_path + "/upstream"\nNODE_JS = emsdk_path + "/node/%%s_64bit/bin/node" %% os.listdir(emsdk_path + "/node")[0]\nCACHE = emsdk_path + "/upstream/emscripten/cache"\nTEMP_DIR = "/tmp"\nCOMPILER_WRAPPER = ""\nPYTHON = "/usr/bin/python3"\n' > /emsdk/.emscripten; \
      fi; \
    fi \
 && chmod a+r /emsdk/.emscripten \
 && python3 -c "import ast; ast.parse(open('/emsdk/.emscripten').read())" \
 && echo "EM_CONFIG ok: /emsdk/.emscripten"
ENV EM_CONFIG=/emsdk/.emscripten

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

# 固化缓存副本: 每个构建任务从该副本拷贝独立缓存(EM_CACHE 由平台按任务覆盖)
RUN CACHE_DIR="$(em-config CACHE 2>/dev/null || true)"; \
    [ -n "$CACHE_DIR" ] || CACHE_DIR="$HOME/.emscripten_cache"; \
    mkdir -p /opt/pristine-cache && \
    cp -a "$CACHE_DIR/." /opt/pristine-cache/ && \
    chmod -R a+rX /opt/pristine-cache

# 平台构建脚本与作品外壳
COPY server/docker/build.js /opt/platform/build.js
COPY server/src/shell.html /opt/platform/shell.html

# 非特权构建用户: 不硬编码用户名 —— 自动选取 UID 1000 用户(无论其用户名),
# 不存在则创建 builder(UID 1000)。官方 emsdk 镜像历史上为 emscripten,
# 现为 ubuntu:noble 自带的 ubuntu 用户, 均以数字 UID 1000 统一引用。
RUN if getent passwd 1000 >/dev/null 2>&1; then \
      echo "选用基础镜像已有 UID 1000 用户: $(getent passwd 1000 | cut -d: -f1)"; \
    else \
      useradd -m -u 1000 -s /bin/bash builder && \
      echo "基础镜像无 UID 1000 用户, 已创建: builder"; \
    fi \
 && mkdir -p /work \
 && chown 1000:1000 /work \
 # —— 运行路径冒烟验证(构建期自检: 环境已固化, 离线可构建) ——
 # 以 UID 1000 + 独立缓存副本 + 平台实际 ENV 组合编译一个最小程序,
 # 等价于运行期构建任务的最小环境, 验证用户/EM_CONFIG/EM_CACHE/缓存全链路。
 && cp -a /opt/pristine-cache /tmp/uid1000-cache \
 && chown -R 1000:1000 /tmp/uid1000-cache \
 && setpriv --reuid 1000 --regid 1000 --clear-groups env \
      HOME=/work EM_CACHE=/tmp/uid1000-cache TMPDIR=/tmp \
      sh -c 'printf "int main(){return 0;}\n" > /tmp/uid1000-check.c \
             && emcc /tmp/uid1000-check.c -o /tmp/uid1000-check.js \
             && echo "UID1000 emcc smoke test OK"' \
 && rm -rf /tmp/uid1000-cache /tmp/uid1000-check.c /tmp/uid1000-check.js /tmp/uid1000-check.wasm

# 以数字 UID 指定运行用户(不依赖用户名, 规避 "unable to find user" 类错误)
USER 1000
WORKDIR /work
ENV HOME=/work
CMD ["sleep", "infinity"]
