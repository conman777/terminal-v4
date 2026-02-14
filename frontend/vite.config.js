import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

if (process.env.VITEST) {
  // Keep React in test/dev mode even if shell exports NODE_ENV=production.
  process.env.NODE_ENV = 'test';
}

const DEV_API_TARGET = process.env.VITE_DEV_API_TARGET || 'http://localhost:3020';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xterm')) return 'vendor-xterm';
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
          if (id.includes('@webcontainer') || id.includes('comlink')) return 'vendor-webcontainer';
          if (id.includes('react-syntax-highlighter') || id.includes('refractor') || id.includes('prism')) {
            return 'vendor-highlight';
          }
          if (
            id.includes('react-markdown') ||
            id.includes('remark-') ||
            id.includes('rehype-') ||
            id.includes('/micromark') ||
            id.includes('/mdast-') ||
            id.includes('/hast-') ||
            id.includes('/unist-') ||
            id.includes('/unified')
          ) {
            return 'vendor-markdown';
          }
          if (id.includes('/diff/')) return 'vendor-diff';
          return 'vendor-misc';
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
        target: DEV_API_TARGET,
        changeOrigin: true,
        ws: true
      },
      '/preview': {
        target: DEV_API_TARGET,
        changeOrigin: true,
        ws: true
      }
    }
  }
});
