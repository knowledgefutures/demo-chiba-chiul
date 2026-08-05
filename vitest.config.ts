import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The corpus round-trip test reads 45 MB of JSONL and hashes ~9.4k records.
    testTimeout: 120_000,
  },
})
