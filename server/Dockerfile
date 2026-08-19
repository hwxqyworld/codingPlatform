# syntax=docker/dockerfile:1
# ============================================================
# cpp-platform-server —— 平台后端容器镜像
#
# 职责:
#   - 运行 Node.js 后端(Express + node:sqlite + dockerode)
#   - 内置 git(git-over-HTTP 通道 http-backend / post-receive hook /
#     本地降级模式)与 curl(hook 回调平台 webhook)
#   - 生产模式由 start-all.js 同进程拉起前端 Next.js standalone
#     (内部 3010)与后端 Express(对外 3000), 页面经后端反向代理
#   - 通过 DOCKER_HOST 连接 DinD 守护进程, 管理构建容器池(cpp-builder)
#
# 数据(DATA_DIR, 默认 /app/server/data)由命名卷持久化;
# 用户代码一律在构建容器内执行, 后端容器不直接运行用户代码。
#
# 构建(在仓库根目录执行, 或直接用 docker compose):
#   docker build -f server/Dockerfile -t cpp-platform-server .
# ============================================================

# ---- 阶段 1: 构建前端(Next.js, standalone 产物) ----
FROM node:22-bookworm-slim AS web-builder
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# prebuild 复制 Monaco 静态资源 -> public/monaco; postbuild 组装 standalone 产物
RUN npm run build

# ---- 阶段 2: 后端运行时 ----
FROM node:22-bookworm-slim

# git: git-over-HTTP(http-backend) + post-receive hook; curl: hook 回调 webhook
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci
COPY server/src server/src
# 前端 standalone 产物(server.js + node_modules + .next/static + public):
# 由 start-all.js 拉起, Express 反代页面请求
COPY --from=web-builder /build/.next/standalone web/.next/standalone

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NEXT_INTERNAL_PORT=3010
EXPOSE 3000

# 数据目录默认落在 /app/server/data, 由 compose 挂载命名卷持久化
CMD ["node", "server/src/start-all.js"]
