import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xterm')) return 'vendor-xterm';
          if (id.includes('react-markdown') || id.includes('remark-') || id.includes('react-syntax-highlighter')) {
            return 'vendor-markdown';
          }
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
          return 'vendor';
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**']
  },
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
