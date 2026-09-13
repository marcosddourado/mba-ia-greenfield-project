> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Processors / Queue Workers (`*.processor.ts`)

A processor is a `@Processor('queue-name')` class extending `WorkerHost` (from `@nestjs/bullmq`) whose `process(job)` method does the async work — for this project, video processing via FFmpeg (per `phase-03-videos/TD-03`, `TD-06`). It consumes what a producer service enqueues (per `TD-02`).

## What to test

A processor crosses **two** system boundaries: the queue (Redis) and whatever the job does (here, storage + FFmpeg + DB). Test the **outcome of processing a real job**, not the wiring:

- Given a real job on a real queue, the `process()` method runs and produces the expected side effects (metadata persisted, thumbnail uploaded, `status` transitioned to `ready`).
- Failure path: a corrupted/invalid source drives `status='failed'` (via `@OnWorkerEvent('failed')`) without crashing the worker.
- Idempotency: re-running the same job yields the same final state (at-least-once delivery means the processor may run twice).
- Progress reporting: `job.updateProgress(n)` is observable via `QueueEvents` (`progress`) — this feeds the SSE status channel (`TD-07`).

## Layer assignment

| Characteristic | Layer | What it validates |
|---|---|---|
| Consumes a queue + touches DB/storage/FFmpeg | **Integration** (real Redis + real worker) | the end-to-end job contract |
| Pure helper extracted from the processor (e.g., a duration parser with branching) | **Unit** | the isolated logic only |
| — | ~~E2E~~ | not applicable — a worker has no HTTP surface |

Processors are **Integration-first**. Do not unit-test the `process()` method by mocking the queue, storage, and FFmpeg all at once — that is a wiring test that proves nothing (§2 of `../SKILL.md`; see `references/mock-health-rules.md`). If a genuinely branchy pure function hides inside the processor, extract it and unit-test that function.

> The `@Processor` decorator does DI/lifecycle magic; instantiating the class with `new` in a unit test bypasses it. Always go through `Test.createTestingModule()` + a real worker for processor behavior.

## Setup pattern (integration — real Redis + real worker)

```typescript
import { Test } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import * as execa from 'execa';

const connection = { host: process.env.REDIS_HOST ?? 'redis', port: 6379 };
const hasFfmpeg = () => { try { execa.sync('ffprobe', ['-version']); return true; } catch { return false; } };

(hasFfmpeg() ? describe : describe.skip)('VideoProcessor (integration)', () => {
  let moduleRef: TestingModule;
  let queue: Queue;
  let events: QueueEvents;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig, queueConfig] }),
        BullModule.forRoot({ connection }),
        BullModule.registerQueue({ name: 'video-processing' }),
        // StorageModule, TypeOrmModule.forFeature([Video]) ...
      ],
      providers: [VideoProcessor /* real */],
    }).compile();
    await moduleRef.init();                 // starts the WorkerHost
    queue = moduleRef.get(getQueueToken('video-processing'));
    events = new QueueEvents('video-processing', { connection });
    await events.waitUntilReady();
  });

  afterEach(async () => { await queue.obliterate({ force: true }); });

  afterAll(async () => {
    await events.close();
    await queue.close();
    await moduleRef.close();                // closes the worker — prevents open Redis handles
  });

  it('processes a valid upload to ready with metadata + thumbnail', async () => {
    const videoId = await seedUploadedVideo(fixturePath);  // status=processing, storage_key set
    const job = await queue.add('process', { videoId });

    await job.waitUntilFinished(events);     // block until the worker finishes

    const video = await videoRepo.findOneByOrFail({ id: videoId });
    expect(video.status).toBe('ready');
    expect(video.duration_seconds).toBeGreaterThan(0);
    expect(video.thumbnail_key).toBeTruthy();
  });
});
```

Key points:
- `job.waitUntilFinished(events)` (or a `completed` listener) is how you await async processing deterministically — never `setTimeout`.
- Always close `QueueEvents`, the `Queue`, and the module in `afterAll` (see `references/gotchas.md` — BullMQ/`ioredis` open handles).
- Run with `--runInBand` (shared Redis + Postgres).

## Unit slice (only for extracted pure logic)

```typescript
describe('parseFfprobeDuration', () => {
  it('returns seconds from ffprobe json', () => {
    expect(parseFfprobeDuration({ format: { duration: '12.34' } })).toBe(12.34);
  });
});
```

## When to skip

- Do NOT write a unit test that mocks Redis + storage + FFmpeg to "cover" `process()` — that is a mock-heavy wiring test.
- Do NOT re-assert FFmpeg's own correctness (that it can read an MP4) — trust the binary; assert YOUR mapping (duration/metadata/thumbnail persisted, status transitions).
- Do NOT test enqueuing here — that is the producer's job (see `artifacts/services.md`).

## Examples from project

- **Not yet implemented.** `VideoProcessor` (`src/videos/processors/video-processing.processor.ts`) arrives with Phase 03 SI-03.10 → Integration spec `video-processing.processor.integration-spec.ts` (real Redis + FFmpeg over a committed fixture), asserting the `ready`/`failed` transitions and idempotency.
