import * as process from 'node:process';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

process.loadEnvFile('.env');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
