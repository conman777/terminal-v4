import { defineConfig } from 'vite';

const apiProxyTarget = process.env.TERMINAL_V4_API_PROXY_TARGET || 'http://127.0.0.1:3020';

if (process.env.VITEST) {
  // Keep React in test/dev mode even if shell exports NODE_ENV=production.
  process.env.NODE_ENV = 'test';
}

export default defineConfig({
  plugins: [{
    name: 'webcontainer-document-isolation',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/webcontainer' || pathname === '/webcontainer/') {
          const setHeader = response.setHeader;
          response.setHeader = function (name, value) {
            return setHeader.call(this, name, name.toLowerCase() === 'cache-control' ? 'no-store' : value);
          };
          response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
          response.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
        }
        next();
      });
    }
  }],
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
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}', 'vite.config.test.js'],
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
        target: apiProxyTarget,
        changeOrigin: false,
        secure: false,
        ws: true
      },
      '/preview': {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
        ws: true
      }
    }
  }
});
