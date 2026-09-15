import * as process from 'node:process';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

process.loadEnvFile('.env');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Batch vehicle imports (up to 100 rows) exceed Express's 100kb JSON default.
  app.useBodyParser('json', { limit: '1mb' });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
