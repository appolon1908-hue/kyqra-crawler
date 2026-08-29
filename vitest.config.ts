import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/**/*.d.ts', 'src/types.ts'],
      thresholds: { lines: 60 },
    },
  },
});
