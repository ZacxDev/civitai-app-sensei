/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base MUST be '/' — the platform serves the build output at the root of the
// app's own subdomain and server-owns the manifest iframe.src (the full-page
// surface iframes the bundle at /apps/run/sensei). No path prefix.
export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5189,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    rollupOptions: { output: { manualChunks: undefined } },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./src/test-setup.ts'],
        },
      },
    ],
  },
});
