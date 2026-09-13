import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './videos/worker.module';

/**
 * Entrypoint for the dedicated video-processing worker container (per
 * phase-03-videos/TD-03). Boots the DI container WITHOUT an HTTP server —
 * `createApplicationContext` starts the BullMQ `@Processor` (via `WorkerModule`),
 * which then consumes `video-processing` jobs until the process is signalled.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('Video-processing worker started', 'Worker');
}
void bootstrap();
