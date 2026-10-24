import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['rete', 'ajv', 'yaml', 'react', 'react-dom'] },
  server: {
    fs: { allow: ['..'] },
    port: 5173,
    host: true,
    // 開發時把 /api（含 SSE）轉給 backend（npm run server，預設 3001）
    proxy: { '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:3001', changeOrigin: true } },
  },
});
