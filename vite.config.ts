import { defineConfig } from 'vite';
export default defineConfig({
  clearScreen: false,
  base: './',
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: 'es2022' },
});
