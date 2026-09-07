import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

describe('QueueModule', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    // `BullModule.forRootAsync` injects `queueConfig.KEY`; its factory context
    // only resolves a GLOBAL ConfigModule (per testing-guide gotchas).
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    // BullMQ opens an ioredis connection — close it or Jest hangs on the handle.
    await moduleRef.close();
  });

  it('compiles the DI container', () => {
    expect(moduleRef).toBeDefined();
  });

  it('exposes the video-processing queue for @InjectQueue injection', () => {
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeDefined();
    expect(queue.name).toBe('video-processing');
  });
});
