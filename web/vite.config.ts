import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['rete', 'ajv', 'yaml', 'react', 'react-dom'] },
  server: { fs: { allow: ['..'] }, port: 5173, host: true },
});
