import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

/**
 * Wires the shared BullMQ Redis connection (reached via the Compose service name
 * `redis`, never `localhost`) and registers the `video-processing` queue so both
 * producers (API) and consumers (worker) can inject it via
 * `@InjectQueue('video-processing')` (per phase-03-videos/TD-02).
 *
 * `BullModule` is re-exported so any module importing `QueueModule` inherits the
 * registered queue provider.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.host,
          port: config.port,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
