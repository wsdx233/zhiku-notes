import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  resolve: { dedupe: ['pdfjs-dist'] },
  server: { host: '0.0.0.0' },
  worker: {
    // 本地文件来源不支持模块 Blob Worker，经典内嵌 Worker 可离线运行。
    format: 'iife',
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: Infinity,
    cssCodeSplit: false,
  },
})
