import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'client/src/**/*.test.ts'],
  },
});
