import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The offline core and the service worker are both browser-agnostic logic:
    // IndexedDB and the network are injected, so they run in plain Node. Tests
    // that need a DOM say so per file with `@vitest-environment jsdom` rather
    // than paying for a DOM in the ones that do not.
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
