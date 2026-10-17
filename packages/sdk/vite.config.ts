import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: [],
  },
  resolve: {
    alias: {
      './client': path.resolve(__dirname, 'src/client.ts'),
      './types': path.resolve(__dirname, 'src/types.ts'),
      './http': path.resolve(__dirname, 'src/http.ts'),
    },
  },
});
