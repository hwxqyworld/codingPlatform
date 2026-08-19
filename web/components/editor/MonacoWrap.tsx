'use client';

import Editor, { loader } from '@monaco-editor/react';
import type { EditorProps } from '@monaco-editor/react';

/**
 * Monaco 编辑器封装 —— 仅在浏览器端加载(dynamic ssr:false)。
 * loader 指向本地静态托管的 monaco(min/vs, 由 scripts/copy-monaco.mjs 生成,
 * 与 Next 产物一起部署), 离线可用, 不依赖 CDN。
 */
loader.config({ paths: { vs: '/monaco/vs' } });

export default function MonacoWrap(props: EditorProps) {
  return <Editor {...props} />;
}
