import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve('src/admin'),
  base: './',
  plugins: [vue(), vueJsx()],
  build: {
    outDir: resolve('dist/admin'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve('src/admin/index.html'),
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/api': 'http://127.0.0.1:4318',
      '/health': 'http://127.0.0.1:4318',
    },
  },
});
