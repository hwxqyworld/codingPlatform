import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { loader } from '@monaco-editor/react';

/**
 * Monaco 编辑器初始化 —— 在 Vite 环境下必须显式声明 Web Worker 的创建方式。
 * C++ 代码编辑只需要基础编辑器 worker; JSON 额外使用语言服务 worker 以获得提示。
 * 全部打包进本地产物, 不依赖 CDN, 离线可用。
 */
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') return new jsonWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

export default monaco;
