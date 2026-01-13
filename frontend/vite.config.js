import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: [
      '.ngrok-free.app',
      '.ngrok.io',
      '.ngrok.app',
      '.serveousercontent.com'
    ],
    proxy: {
      '/api': {
        target: 'http://localhost:3020',
        changeOrigin: true,
        ws: true
      },
      '/preview': {
        target: 'http://localhost:3020',
        changeOrigin: true,
        ws: true
      }
    }
  }
});
