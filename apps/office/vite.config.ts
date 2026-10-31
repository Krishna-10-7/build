import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const api = process.env.SENTINEL_URL ?? 'http://localhost:4200';

export default defineConfig({
  // Two pages: the lobby at <server>/ and the office floors at <server>/office/.
  base: './',
  server: {
    port: 5174,
    proxy: {
      '/api': api,
      '/arena/ws': { target: api.replace(/^http/, 'ws'), ws: true },
      '/console': api,
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: { input: { lobby: resolve(import.meta.dirname, 'index.html'), office: resolve(import.meta.dirname, 'office/index.html') } },
  },
});
