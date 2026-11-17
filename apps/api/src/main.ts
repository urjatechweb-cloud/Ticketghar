import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { migrate } from './db/migrate';

export function configureApp(app: { useGlobalPipes: Function; enableCors: Function }, webUrl: string) {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: [webUrl], credentials: false });
}

async function bootstrap() {
  const config = loadConfig();
  await migrate(config.databaseUrl);
  // rawBody keeps the exact bytes Meta signed, needed to verify WhatsApp webhooks.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app, config.webUrl);
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`TicketGhar API on :${config.port}`);
}

if (require.main === module) {
  bootstrap();
}
