import { defineConfig } from 'vitest/config';

// Geo-alignment and data tests: plain Node, read the shipped binaries in public/data and test/fixtures.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 120_000,
    reporters: ['verbose'],
  },
});
