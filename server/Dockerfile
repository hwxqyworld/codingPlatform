# syntax=docker/dockerfile:1
# ============================================================
# cpp-platform-server —— 平台后端容器镜像
#
# 职责:
#   - 运行 Node.js 后端(Express + node:sqlite + dockerode)
#   - 内置 git(git-over-HTTP 通道 http-backend / post-receive hook /
#     本地降级模式)与 curl(hook 回调平台 webhook)
#   - 生产模式同端口托管前端构建产物(前端代码不变, 仅在镜像内构建)
#   - 通过 DOCKER_HOST 连接 DinD 守护进程, 管理构建容器池(cpp-builder)
#
# 数据(DATA_DIR, 默认 /app/server/data)由命名卷持久化;
# 用户代码一律在构建容器内执行, 后端容器不直接运行用户代码。
#
# 构建(在仓库根目录执行, 或直接用 docker compose):
#   docker build -f server/Dockerfile -t cpp-platform-server .
# ============================================================

# ---- 阶段 1: 构建前端(代码与配置保持不变, 产物打入镜像由后端托管) ----
FROM node:22-bookworm-slim AS web-builder
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
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
# 前端产物: app.js 默认从 ../../web/dist 加载(与本地目录结构一致, 无需改代码)
COPY --from=web-builder /build/dist web/dist

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
EXPOSE 3000

# 数据目录默认落在 /app/server/data, 由 compose 挂载命名卷持久化
CMD ["node", "server/src/index.js"]
