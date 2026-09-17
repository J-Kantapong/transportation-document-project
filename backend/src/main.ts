import * as process from 'node:process';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

try {
  // No .env file in production (Render injects env vars directly); .env is dev-only.
  process.loadEnvFile('.env');
} catch {}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Batch vehicle imports (up to 100 rows) exceed Express's 100kb JSON default.
  app.useBodyParser('json', { limit: '1mb' });
  // The Next.js frontend runs on its own dev port; allow it to call this API in development.
  app.enableCors({ origin: process.env.FRONTEND_ORIGIN ?? true });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
