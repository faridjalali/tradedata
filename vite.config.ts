import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: './', // Root is now the project root where index.html lies
  base: './', // Relative base path
  publicDir: 'public', // Static assets
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-charts': ['lightweight-charts'],
        },
      },
    },
  },
});
