import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from './common/filters/validation-exception.filter';
import swaggerConfig from './config/swagger.config';
import { buildSwaggerDocument } from './swagger/swagger-document';
import swaggerMetadata from './metadata.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') ?? 3000;

  // Per-request access log (method, url, status, duration). NestJS does not log
  // HTTP requests by default; this makes request activity visible in dev.
  const httpLogger = new Logger('HTTP');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      httpLogger.log(
        `${req.method} ${req.originalUrl} ${res.statusCode} - ${Date.now() - startedAt}ms`,
      );
    });
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );

  const swagger = app.get<ConfigType<typeof swaggerConfig>>(swaggerConfig.KEY);

  if (swagger.enabled) {
    await SwaggerModule.loadPluginMetadata(swaggerMetadata);
    const document = buildSwaggerDocument(app);
    SwaggerModule.setup('api/docs', app, document, {
      customSiteTitle: 'StreamTube API Docs',
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(port);
}
void bootstrap();
