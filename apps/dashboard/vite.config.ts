import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.SENTINEL_URL ?? 'http://localhost:4200';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/artifacts': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
});
