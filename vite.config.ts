import { defineConfig } from 'vitest/config';

// Served from https://<user>.github.io/personal-selectors/, so assets need the
// repo name as their base path. Override with BASE_PATH=/ for a root deploy.
const base = process.env['BASE_PATH'] ?? '/personal-selectors/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    cssTarget: 'chrome110',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
