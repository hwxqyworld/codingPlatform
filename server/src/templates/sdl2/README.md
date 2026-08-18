# 我的 C++ 作品

基于 SDL2 + Emscripten 编写, 由平台自动编译为 WebAssembly 运行在浏览器中。

## 开发流程

- 在线编辑: 修改代码后「提交」到 develop 分支(内部), 点「发布」推送到 main。
- git 命令行: `git push origin develop` 内部开发; `git push origin main` 公开并计一次更新。
- 资源文件放到 `assets/` 目录, 构建时自动预加载。

## 构建配置

见 `compile.json`。常用选项:

```json
{
  "sources": ["main.cpp", "src/*.cpp"],
  "libraries": ["SDL2", "SDL2_image", "SDL2_ttf", "SDL2_mixer"],
  "flags": ["-O2", "-sALLOW_MEMORY_GROWTH=1"],
  "preload": ["assets"]
}
```
