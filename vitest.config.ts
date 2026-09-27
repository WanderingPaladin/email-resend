import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'shared'), '@': resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Electron modules are never loaded in unit tests; services receive fakes instead.
    restoreMocks: true,
  },
});
