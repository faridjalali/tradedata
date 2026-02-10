import { defineConfig } from 'vite';

export default defineConfig({
  root: './',      // Root is now the project root where index.html lies
  base: './',      // Relative base path
  publicDir: 'public', // Static assets
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/webhook': 'http://localhost:3000'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
});
