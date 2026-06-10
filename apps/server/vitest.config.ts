import { defineConfig } from 'vitest/config'

const testDatabaseUrl =
  process.env.TIDEBASE_TEST_DATABASE_URL ??
  'postgres://tidebase:tidebase@localhost:7432/tidebase_test'

export default defineConfig({
  test: {
    pool: 'forks',
    globalSetup: './test/global-setup.ts',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      DATABASE_URL: testDatabaseUrl,
      TIDEBASE_WEBHOOK_SECRET: 'test-webhook-secret'
    }
  }
})
