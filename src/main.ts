import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('bootstrap');
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const appEnv = config.get<string>('APP_ENV', 'local');
  // Local: any origin (developer convenience). Elsewhere: explicit allow-list from CORS_ORIGINS.
  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors(appEnv === 'local' && origins.length === 0 ? { origin: true } : { origin: origins, credentials: false });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Lets Prisma disconnect cleanly on SIGTERM (ECS/Docker stop).
  app.enableShutdownHooks();

  // Swagger stays on for local/staging/pilot; production needs SWAGGER_ENABLED=true.
  if (appEnv !== 'production' || config.get<string>('SWAGGER_ENABLED') === 'true') {
    const doc = new DocumentBuilder()
      .setTitle('AlKÉ Finance API')
      .setDescription(
        "API backend AlKÉ Finance — auth, KYC, wallet, catalogue multi-marché (BVMAC/BRVM/INTL), moteur d'ordres, back-office.",
      )
      .setVersion(process.env.APP_VERSION ?? '0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  }

  const port = config.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`AlKÉ Finance API (${appEnv}) listening on :${port}${appEnv !== 'production' ? ' — docs at /docs' : ''}`);
}
bootstrap();
