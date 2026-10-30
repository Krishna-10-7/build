import { defineConfig } from 'vite';

const api = process.env.SENTINEL_URL ?? 'http://localhost:4200';

export default defineConfig({
  // Served at <server>/office/, and the API sits one level up.
  base: './',
  server: {
    port: 5174,
    proxy: {
      '/api': api,
      '/arena/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 900 },
});
