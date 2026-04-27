import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Discord serviert die Activity ueber /.proxy/, daher relative Pfade
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  // Wichtig: relative Pfade fuer Discord Proxy
  base: './',
});
