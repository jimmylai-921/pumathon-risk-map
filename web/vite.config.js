import { defineConfig } from 'vite';

// base: './' 讓 dist/ 可丟到任何子路徑的 static hosting
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
});
