import { defineConfig } from 'vitest/config';

// Each test file builds whole gateways (six schemas, six pools each); one file at a time keeps
// the connection count well under the server limit.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
