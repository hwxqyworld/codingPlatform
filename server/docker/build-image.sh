#!/usr/bin/env sh
# 构建平台构建容器镜像(在仓库根目录执行)
set -e
cd "$(dirname "$0")/../.."
docker build -f server/docker/Dockerfile -t cppplay-builder .
echo ""
echo "镜像 cppplay-builder:latest 已就绪。"
echo "启动平台时设置 BUILD_MODE=container 即启用容器构建(安全模式)。"
