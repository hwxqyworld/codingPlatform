@echo off
rem ============================================================
rem  创玩 · C++ 创作平台 —— Emscripten 工具链一键安装
rem  安装位置: %USERPROFILE%\emsdk (平台会自动探测该路径)
rem ============================================================
setlocal

if exist "%USERPROFILE%\emsdk\.git" goto activate

echo [1/3] 克隆 emsdk 仓库...
git clone https://github.com/emscripten-core/emsdk.git "%USERPROFILE%\emsdk"
if errorlevel 1 (
  echo 克隆失败, 请检查网络后重试。
  exit /b 1
)

:activate
echo [2/3] 安装最新版 Emscripten(首次约需下载数百 MB, 请耐心等待)...
cd /d "%USERPROFILE%\emsdk"
emsdk.bat install latest
if errorlevel 1 (
  echo 安装失败, 请检查网络后重试。
  exit /b 1
)

echo [3/3] 激活工具链...
emsdk.bat activate latest
if errorlevel 1 (
  echo 激活失败。
  exit /b 1
)

echo.
echo ============================================================
echo  安装完成!
echo  平台会自动探测以下目录中的 emcc, 无需手动配置 PATH:
echo    %USERPROFILE%\emsdk\upstream\emscripten\emcc.bat
echo  重启平台服务后, 重新发布作品即可完成 WebAssembly 构建。
echo  验证: node server\tests 或直接创建作品并发布。
echo ============================================================
endlocal
