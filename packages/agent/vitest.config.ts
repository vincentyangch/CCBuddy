import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@anthropic-ai/claude-code': path.resolve(
        __dirname,
        'src/__mocks__/@anthropic-ai/claude-code.ts',
      ),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
