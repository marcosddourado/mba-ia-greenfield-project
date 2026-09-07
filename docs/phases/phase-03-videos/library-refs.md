---
libs:
  "@aws-sdk/client-s3":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-06T18:19:58-0300"
  "@aws-sdk/s3-request-presigner":
    version: "^3"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-06T18:19:58-0300"
  "@nestjs/bullmq":
    version: "^11"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-06T18:19:58-0300"
  "bullmq":
    version: "^5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-06T18:19:58-0300"
  "nanoid":
    version: "^3"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-09-06T18:19:58-0300"
  "execa":
    version: "^5"
    context7_id: "/sindresorhus/execa"
    fetched_at: "2026-09-06T18:19:58-0300"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-06T18:15:08-0300"
---

# phase-03-videos — Library Reference Cache

_Distilled Context7 excerpts scoped to the Phase 03 usage surfaces (TD-01/04/08 storage + presigning, TD-02/03 queue + worker, TD-05 short id, TD-06 ffmpeg invocation, TD-07 SSE). Fetched during `/plan-resolve phase-03`. Cross-reference the decisions doc for the "why"; this file is the "how"._

### @aws-sdk/client-s3

_TD-01 (object storage), TD-04 (multipart upload), TD-08 (delivery). Use v3 modular clients. `S3Client` config for MinIO: custom `endpoint`, `forcePathStyle: true`, explicit `region`, static `credentials`._

```typescript
import { S3Client } from "@aws-sdk/client-s3";

// MinIO in dev; prod flips `endpoint` to the AWS S3 regional endpoint (identical code).
// NOTE (masked-gateway, TD-04): the INTERNAL endpoint (e.g. http://minio:9000) is used by the
// API/worker for control-plane calls; presigned URLs handed to the browser must be generated
// against the PUBLIC gateway endpoint (see s3-request-presigner note below), never `minio:9000`.
const s3 = new S3Client({
  endpoint: "http://minio:9000",   // internal Compose service host for API/worker
  forcePathStyle: true,             // required for MinIO / path-style buckets
  region: "us-east-1",
  credentials: { accessKeyId: "...", secretAccessKey: "..." },
});
```

- **Multipart upload commands** (TD-04, 10GB resumable): `CreateMultipartUploadCommand` → per-part `UploadPartCommand` (each part presigned for the browser) → `CompleteMultipartUploadCommand` (with the collected `{ ETag, PartNumber }[]`). `AbortMultipartUploadCommand` for cleanup on failure.
- **`GetObjectCommand` / `GetObjectRequest`** (TD-08): supports `ResponseContentDisposition` (force download filename, e.g. `attachment; filename="video.mp4"`), `ResponseContentType`, and `Range` (byte-range streaming). `GetObjectCommandOutput.Body` is a streaming payload.

### @aws-sdk/s3-request-presigner

_TD-04 (presigned UploadPart URLs), TD-08 (presigned GET with Range + attachment). `getSignedUrl(client, command, { expiresIn })` — default `expiresIn` is 900s (15 min)._

```typescript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, UploadPartCommand, GetObjectCommand } from "@aws-sdk/client-s3";

// Presigned part URL for browser multipart upload (TD-04):
const partUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// Presigned GET for streaming (Range preserved) + download (content-disposition) (TD-08):
const getUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: `attachment; filename="${name}"` }),
  { expiresIn: 3600 },
);
```

- **`Range` is preserved**: `getSignedUrl` only strips SDK-internal headers (`amz-sdk-invocation-id`, `amz-sdk-request`, `x-amz-user-agent`); a `Range` set on the command is signed and embedded, so range streaming works from a presigned URL.
- **Masked-gateway (TD-04/TD-08):** generate presigned URLs against the PUBLIC gateway host, not the internal `minio:9000`. Options: (a) construct the presigner's `S3Client` with `endpoint` = the public gateway URL; or (b) generate against the internal endpoint then rewrite the host to the public gateway (only safe if the signature's host/SigV4 covers the public host — prefer (a) so the signed host matches what the browser hits). The reverse-proxy/gateway forwards to MinIO/S3. Confirm CORS on the public endpoint for browser `PUT`/`GET`.
- **`unhoistableHeaders`**: pass `x-amz-*` header names (e.g. `x-amz-checksum-sha256`) to keep them signed in the request rather than hoisted to the query string.

### @nestjs/bullmq

_TD-02 (queue producer in API), TD-03 (worker consumes). NestJS wrapper over BullMQ. `@nestjs/bullmq` re-exports the decorators/host classes; `bullmq` provides `Queue`/`Job` types._

```typescript
// Root config (shared Redis connection) — use Compose service name `redis` per CLAUDE.md:
import { BullModule } from '@nestjs/bullmq';
@Module({
  imports: [
    BullModule.forRoot({ connection: { host: 'redis', port: 6379 } }),
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
})
export class AppModule {}

// Producer (API side, TD-02) — inject the queue and enqueue on upload completion:
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
@Injectable()
export class UploadService {
  constructor(@InjectQueue('video-processing') private queue: Queue) {}
  async enqueue(videoId: string) { await this.queue.add('process', { videoId }); }
}

// Consumer (worker side, TD-03) — extend WorkerHost, report progress (feeds TD-07 SSE):
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>) {
    await job.updateProgress(25);   // (docs also show job.progress(n))
    // ...ffprobe metadata + ffmpeg thumbnail (TD-06)...
    await job.updateProgress(100);
    return { ok: true };
  }
  @OnWorkerEvent('failed') onFailed(job: Job, err: Error) { /* mark video failed */ }
}
```

- The worker (TD-03) runs as a **separate container** with the same codebase but a distinct entrypoint bootstrapping only the queue-consuming module + FFmpeg base image.
- Progress/`completed`/`failed` events are the signal source for the TD-07 status model; the API's SSE stream (below) can be driven off `QueueEvents` or the persisted status column updated by the worker.

### bullmq

_Core queue engine (TD-02/03). `Queue` (add jobs), `Worker` (process), `Job` (`data`, `updateProgress`, `id`), `QueueEvents` (`completed`/`failed`/`progress`). Requires a Redis connection (`{ connection: { host, port } }`, or an ioredis instance with `maxRetriesPerRequest: null` for workers). v5._

```typescript
import { Queue, Worker, QueueEvents } from 'bullmq';
const connection = { host: 'redis', port: 6379 };
const queue = new Queue('video-processing', { connection });
await queue.add('process', { videoId });

const worker = new Worker('video-processing', async (job) => {
  await job.updateProgress(50);
  return { framerate: 29.97 };
}, { connection });

const events = new QueueEvents('video-processing', { connection });
events.on('progress', ({ jobId, data }) => { /* push to SSE */ });
events.on('completed', ({ jobId }) => { /* mark ready */ });
events.on('failed', ({ jobId, failedReason }) => { /* mark failed */ });
```

### nanoid

_TD-05 (unique public video id / short URL). **Pinned to v3 for CommonJS** — v4.0 removed CJS (ESM-only); v3.x is the last CJS branch. NestJS project is CJS, so `nanoid@^3`._

```javascript
// v3 CJS: require works.
const { customAlphabet, nanoid } = require('nanoid');

// Default: 21-char URL-safe id.
const id = nanoid();

// Recommended for public_id: fixed-size custom alphabet (URL-friendly, controllable length).
const makeSlug = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 11);
const publicId = makeSlug(); // e.g. "V1StGXR8_Z"-style, 11 chars
```

- `customAlphabet(alphabet, defaultSize)` returns `(size?) => string`; alphabet must be ≤256 chars. Store the result in the `Video.public_id` column with a unique index; on rare collision, retry generation.
- **CJS caveat is load-bearing:** do NOT bump to nanoid ≥4 without migrating the project to ESM.

### execa

_TD-06 (direct ffmpeg/ffprobe invocation, no fluent-ffmpeg wrapper). **Pinned to v5 for CommonJS** — v6+ is ESM-only. v5 uses `const execa = require('execa')` and the call form `execa(file, args[])`._

```javascript
// v5 CJS form (the pinned version this project uses):
const execa = require('execa');

// ffprobe: extract duration + metadata as JSON.
const { stdout } = await execa('ffprobe', [
  '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath,
]);
const meta = JSON.parse(stdout);
const durationSec = Number(meta.format.duration);

// ffmpeg: single-frame thumbnail at t=1s.
await execa('ffmpeg', ['-ss', '1', '-i', inputPath, '-frames:v', '1', '-q:v', '2', thumbPath]);
```

- **Error handling:** on non-zero exit, execa rejects; the error carries `exitCode`, `stdout`, `stderr`, `shortMessage`. Use `try/catch` (or `{ reject: false }` to inspect `exitCode` without throwing) to mark the video `failed`.
- **API note:** the modern Context7 samples show the ESM template-tag form (`` execa`...` ``, `$`...``) — that is v8+. For the pinned **v5**, use the function form above (`execa(file, argsArray, options)`); `execaSync` exists for sync calls. Node's built-in `child_process.spawn` (promisified) is the zero-dep fallback within TD-06 Option B.

### NestJS SSE (@Sse)

_TD-07 (processing-status push channel). Native NestJS — no new runtime dependency (RxJS ships with Nest). `@Sse('path')` handler returns `Observable<MessageEvent>`._

```typescript
import { Sse, MessageEvent } from '@nestjs/common';
import { Observable, interval, map, finalize } from 'rxjs';

@Sse('videos/:id/status')
status(): Observable<MessageEvent> {
  // Drive off QueueEvents / a status subject; poll DB or subscribe to progress.
  return interval(1000).pipe(
    map((_) => ({ data: { status: 'processing', progress: 42 } }) as MessageEvent),
    finalize(() => { /* client disconnected — cleanup subscription */ }),
  );
}
```

- Each emitted value must be a `MessageEvent` (`{ data, id?, type?, retry? }`); `data` is JSON-serialized to the SSE `data:` field.
- Use `finalize()` to release the underlying `QueueEvents`/subscription when the client disconnects.
- The status enum still backs a one-shot `GET /videos/:id` DTO field (TD-07) for non-streaming reads; SSE is the live channel layered on top.
