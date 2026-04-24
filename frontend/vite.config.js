import { defineConfig } from 'vite';

if (process.env.VITEST) {
  // Keep React in test/dev mode even if shell exports NODE_ENV=production.
  process.env.NODE_ENV = 'test';
}

export default defineConfig({
  plugins: [],
  esbuild: {
    jsx: 'automatic'
  },
  optimizeDeps: {
    entries: ['index.html'],
    holdUntilCrawlEnd: false,
    noDiscovery: true,
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime'
    ]
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xterm')) return 'vendor-xterm';
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
          if (id.includes('@webcontainer') || id.includes('comlink')) return 'vendor-webcontainer';
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
    preTransformRequests: false,
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
