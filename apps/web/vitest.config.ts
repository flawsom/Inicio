import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The offline core and the service worker are both browser-agnostic logic:
    // IndexedDB and the network are injected, so they run in plain Node.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
