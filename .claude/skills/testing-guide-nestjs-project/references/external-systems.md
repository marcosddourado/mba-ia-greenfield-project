> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. Strategies were confirmed with the team and aligned with the Phase 03 technical decisions (`docs/decisions/technical-decisions-phase-03-videos.md`).

| System | Strategy | Why |
|---|---|---|
| PostgreSQL | **Real** (Docker `db`) | Fast, controllable, no rate limits |
| Object storage (MinIO/S3) | **Real** (Docker `minio`) | MinIO *is* the local S3 emulator; presigned-URL + multipart contracts must be exercised for real |
| Redis + BullMQ | **Real** (Docker `redis`) | Queue/worker contract matters; TTL/lifecycle events depend on real Redis |
| FFmpeg | **Real** binaries (worker image) | ffprobe/ffmpeg output is the contract; no faithful fake exists |
| Email (SMTP) | **Fake capture** (Mailpit, Docker) | Real SMTP is slow and has side effects; Mailpit captures the full transport path |

---

## PostgreSQL — Real (Docker `db`)

Use the project helper `src/test/create-test-data-source.ts` rather than hand-rolling a `DataSource`:

```typescript
import { createTestDataSource, cleanAllTables } from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = createTestDataSource([User, Channel, Video]); // synchronize: true by default
  await dataSource.initialize();
});

afterEach(async () => {
  await cleanAllTables(dataSource); // DELETEs in reverse-FK order
});

afterAll(async () => {
  await dataSource.destroy();
});
```

**Test isolation:**
- Clean with `dataSource.query('DELETE FROM "table"')` — never `repository.delete({})` (throws `Empty criteria(s) are not allowed`).
- **When you add a new entity, extend `cleanAllTables()` in reverse-FK order.** `videos.channel_id → channels.id`, so delete `videos` **before** `channels`:
  ```typescript
  await dataSource.query('DELETE FROM "videos"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
  ```
- Integration specs import only the entities they need; E2E imports `AppModule` (all entities).
- To test migrations rather than `synchronize`, pass `{ synchronize: false, migrations: [...] }` (see `src/database/migrations.integration-spec.ts`).

> The helper reads `DB_DATABASE` (falling back to `streamtube`); the container's `.env` defines `DB_NAME`, so tests use the default DB name. Keep new DB config consistent with the helper.

---

## Object Storage — MinIO (Real, Docker) — per TD-01 / TD-04 / TD-08

MinIO is the S3-compatible object store in dev/test; production flips the endpoint to AWS S3 with identical code.

**Docker service** (added by Phase 03 SI-03.1):
```yaml
minio:
  image: minio/minio
  command: server /data --console-address ":9001"
  environment:
    - MINIO_ROOT_USER=streamtube
    - MINIO_ROOT_PASSWORD=streamtube
  ports: ["9000:9000", "9001:9001"]
```

**S3Client for tests** — path-style is mandatory for MinIO:
```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
  forcePathStyle: true,          // REQUIRED for MinIO / path-style buckets
  region: 'us-east-1',
  credentials: { accessKeyId: 'streamtube', secretAccessKey: 'streamtube' },
});
```

**Integration test — assert the presigned URL is real, not the string:**
```typescript
it('presigns a GET that streams a byte range', async () => {
  await s3.send(new PutObjectCommand({ Bucket, Key, Body: fixture }));
  const url = await storageService.presignGet(Key);           // signs against the public host

  const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });
  expect(res.status).toBe(206);                               // Partial Content — Range honored
});
```

**Key points:**
- Test the **behavior of the URL** (real HTTP PUT for parts → 200; GET with `Range` → 206; download URL → `content-disposition: attachment`), never a mocked return value.
- **Masked-gateway note (TD-04/08):** production presigns against the public gateway host, never `minio:9000`. In tests, sign against the MinIO endpoint the test can actually reach.
- **SDK-v3 pitfall:** MinIO may return `AccessDenied` about *unsigned headers* when the browser/`fetch` sends a header the signature didn't cover. Keep `x-amz-*` headers signed via `unhoistableHeaders`, and don't add headers to the request that weren't part of the signed command.
- Cleanup: delete objects (and the test bucket) in `afterAll`; use a per-suite key prefix to avoid cross-test collisions.

---

## Message Queue — Redis + BullMQ (Real, Docker) — per TD-02 / TD-03

**Docker service** (Phase 03 SI-03.1):
```yaml
redis:
  image: redis:7
  ports: ["6379:6379"]
```

**Producer (unit)** — enqueuing is a boundary side effect; mock the queue:
```typescript
const queue = { add: jest.fn() };
// providers: [{ provide: getQueueToken('video-processing'), useValue: queue }]
await service.completeUpload(publicId, parts);
expect(queue.add).toHaveBeenCalledWith('process', { videoId: expect.any(String) });
```

**Producer (integration)** — real Redis; inspect the queue:
```typescript
BullModule.forRoot({ connection: { host: process.env.REDIS_HOST ?? 'redis', port: 6379 } }),
BullModule.registerQueue({ name: 'video-processing' }),
// ...
const queue = module.get<Queue>(getQueueToken('video-processing'));
await service.completeUpload(publicId, parts);
const jobs = await queue.getJobs(['waiting']);
expect(jobs[0].data).toEqual(expect.objectContaining({ videoId: expect.any(String) }));
```

**Teardown (mandatory — prevents open handles):**
```typescript
afterAll(async () => {
  await queue.obliterate({ force: true }); // clear jobs
  await queue.close();
  await module.close();                    // closes workers registered via @Processor
});
```

- Use a dedicated test queue name or `obliterate`/`drain` between tests for isolation.
- For consumer/worker behavior, see `artifacts/processors.md`.

---

## FFmpeg — Real binaries (worker image) — per TD-06

Video processing shells out to `ffprobe`/`ffmpeg` via `execa@^5` (CJS function form `execa(file, args[])`).

- ffmpeg/ffprobe must be on `PATH` — they live in the worker container's base image (SI-03.10). Run these integration specs where the binaries exist (worker image / CI step with ffmpeg installed).
- Commit a small fixture video under a test fixtures dir; assert extracted `duration_seconds`/`metadata` and that a thumbnail file was produced.
- Guard against missing binaries so the suite fails loudly rather than mysteriously:
  ```typescript
  const hasFfmpeg = () => { try { execa.sync('ffprobe', ['-version']); return true; } catch { return false; } };
  (hasFfmpeg() ? describe : describe.skip)('VideoProcessor (integration)', () => { /* ... */ });
  ```
- On a corrupted source, assert the processor marks the video `failed` (via `@OnWorkerEvent('failed')`) without crashing the worker.

---

## Email — Mailpit (Real SMTP capture, Docker)

Use the project helpers in `src/test/mailpit.ts` — do not hand-roll `fetch` calls.

```typescript
import { getMailpitMessages, clearMailpitMessages } from '../test/mailpit';

beforeEach(async () => { await clearMailpitMessages(); });

it('sends a confirmation email', async () => {
  await mailService.sendConfirmation('user@test.com', 'token-123');
  const messages = await getMailpitMessages();
  expect(messages).toHaveLength(1);
  expect(messages[0].To[0].Address).toBe('user@test.com');
});
```

- Mailpit captures ALL mail — no delivery, no mocking. It exercises the real SMTP transport, so a wrong host/port/`MAIL_FROM` fails the test.
- Helpers target `http://${MAIL_HOST ?? 'mailpit'}:8025` (`getMailpitMessages`, `getMailpitMessage(id)`, `clearMailpitMessages`).
- Clear captured mail in `beforeEach` for isolation.
