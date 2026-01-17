import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@bindings': path.resolve(__dirname, '../bindings'),
    },
  },
  test: {
    environment: 'node',
    hookTimeout: 10000,
    testTimeout: 30000,
  },
})
