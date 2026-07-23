import { defineConfig } from '@playwright/test';

// Порт для e2e — отдельный, чтобы не конфликтовать с dev-инстансом.
const PORT = 3999;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Фейковые камера/микрофон + авто-разрешение доступа: getUserMedia
    // отдаёт синтетический поток, звонок реально устанавливается на localhost.
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream'
      ]
    }
  },
  // Сервер поднимается сам (собирается из TS и запускается на тестовом порту).
  webServer: {
    command: 'npm run build && node dist/server.js',
    url: `http://localhost:${PORT}/api/ice-servers`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      ADMIN_TOKEN: 'e2e-admin-token',
      SESSION_SECRET: 'e2e-session-secret'
    }
  }
});
