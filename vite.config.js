import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { host: '0.0.0.0' },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          markdown: ['marked', 'marked-footnote', 'dompurify'],
          math: ['katex'],
          highlight: ['highlight.js/lib/common'],
          archive: ['jszip'],
        },
      },
    },
  },
})
