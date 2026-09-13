---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-06
scope_description: "Backend + cross-layer foundation for Phase 03 — object storage, background-job queue, video worker topology, large-file (10GB) resumable upload protocol, unique public video URL, FFmpeg processing (metadata + thumbnail), video lifecycle/status model, and media delivery (streaming + download). Frontend screen composition (upload page UI, progress) is deferred to a future `phase-03-videos-frontend` slice."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — primary. Owns storage service, queue producer, the video worker (FFmpeg), the `Video` entity + migration, upload orchestration endpoints, presigned-URL issuance, and processing-status exposure. All Backend TDs and the backend side of every Cross-layer TD live here.
- `next-frontend/` — consumes the Cross-layer contracts settled here (upload handshake, public video URL shape, processing-status polling, streaming/download URLs) but has **no Frontend-only TD in this document**. Rationale: Phase 03 has no purely-FE capability bullet in `project-plan.md` (the video player is Phase 05); the FE upload-screen composition is a UI-assembly task deferred to a future `phase-03-videos-frontend` slice, mirroring the `phase-02-auth` → `phase-02-auth-frontend` split. This doc settles the contracts that slice will bind to.

**Inherited decisions (hard constraints — not reopened here):**

- Config: `ConfigModule` + namespaced configs + Joi env validation (`phase-01-configuracao-base`). New storage/queue/worker settings follow this pattern and are validated in the Joi schema.
- Validation: `class-validator` + `class-transformer` for DTOs (`phase-02-auth/TD-06`).
- Error contract: Custom Domain Exception Filter returning `{ statusCode, error, message }` (`phase-02-auth/TD-07`, Cross-layer). New endpoints emit errors through this filter.
- Auth: custom guards with `@nestjs/jwt` (`phase-02-auth/TD-02`); upload/management endpoints are authenticated, anonymous access to playback is a Phase 05 concern.
- Rate limiting: `@nestjs/throttler` (`phase-02-auth/TD-08`).
- API contract sync: NestJS emits `openapi.json` (`openapi-docs-nestjs/TD-02`), consumed by `next-frontend` via codegen (`next-frontend-openapi-typing`). New video endpoints are documented with `@nestjs/swagger` decorators so the FE gets typed clients for free.
- Entity conventions: UUID PK via `@PrimaryGeneratedColumn('uuid')`, snake_case columns, `CreateDateColumn`/`UpdateDateColumn`, TypeORM Data Mapper + migrations (observed in `channels`/`users` entities).

**Docker networking note (applies to TD-01, TD-04, TD-08):** per `CLAUDE.md`, containers reference each other by Compose service name (`minio`, `redis`). But **presigned URLs handed to the browser must use a host the browser can reach** (e.g. `localhost:9000`), not the internal service name. This split (internal endpoint for the API/worker vs public endpoint baked into presigned URLs) is a recurring implementation constraint flagged in the affected TDs.

**Scope boundary — no adaptive-bitrate transcoding.** The plan requires metadata extraction, a thumbnail, and "streaming (sem necessidade de download completo)". HTTP Range requests over the stored file satisfy progressive streaming without transcoding to HLS/DASH. Multi-resolution/ABR transcoding is **out of scope** for Phase 03 (gold-plating); TD-06 and TD-08 are scoped accordingly.

---

## TD-01: Object Storage Backend & SDK

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Phase 03 is the first phase to persist binary blobs (videos up to 10GB + generated thumbnails). The architecture diagram names an "Object Storage (S3/MinIO)" container. We need to choose the dev/prod storage backend and the client library. This choice is cited across `compose.yaml` (new service), the Joi env schema, the storage service, the worker, and every presigned-URL call — a genuine cross-component contract.

**Options:**

### Option A: MinIO (self-hosted, S3-compatible) via `@aws-sdk/client-s3`
- Run MinIO as a Compose service in dev; talk to it with the AWS SDK v3 S3 client pointed at MinIO's `endpoint` (`forcePathStyle: true`). Prod swaps only the endpoint/credentials env to hit real AWS S3 — no code change.
- **Pros:** Same SDK and code path in dev and prod; zero cloud cost/credentials for local dev; realistic S3 semantics (multipart, presigned URLs, Range); matches the arch diagram.
- **Cons:** One more Compose service to run; a persistent volume to manage; presigned-URL host must be browser-reachable (see Docker networking note).

### Option B: AWS S3 directly (even in dev)
- Point `@aws-sdk/client-s3` at real S3 buckets in all environments.
- **Pros:** No local storage service; true production parity.
- **Cons:** Requires AWS credentials + a real bucket for every developer; local dev incurs cost and network dependency; offline dev impossible — poor fit for an MBA/greenfield project run entirely via Docker Compose.

### Option C: Local filesystem volume (no object store)
- Store files on a mounted Docker volume; serve via the API.
- **Pros:** Simplest; no extra service.
- **Cons:** No presigned URLs (API becomes the data path for 10GB files — violates "sem impacto na performance"); no native multipart/resume; diverges hard from the documented S3/MinIO architecture; not portable to prod.

**Recommendation:** Option A — MinIO in dev via `@aws-sdk/client-s3` (+ `@aws-sdk/s3-request-presigner`) with `forcePathStyle: true`; prod flips the endpoint to AWS S3. This is the only option that gives identical code across environments while keeping the API out of the 10GB data path.

**Decision:** Option A — MinIO (self-hosted, S3-compatible) in dev via `@aws-sdk/client-s3` (+ `@aws-sdk/s3-request-presigner`, `forcePathStyle: true`); prod flips the endpoint to AWS S3 with identical code.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: Background-Job / Message-Queue System

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video processing (ffprobe metadata + thumbnail) is CPU-heavy and must run off the request path ("sem bloquear o usuário", Pontos de Atenção). The arch diagram shows a dedicated Message Queue container feeding a Video Worker. We must choose the queue engine. This drives new infra (broker service), the producer in the API, and the consumer in the worker (TD-03).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Nest-idiomatic queue on Redis. Producers use `@InjectQueue`; the worker extends `WorkerHost` with `@Processor`, `process()`, `@OnWorkerEvent`, per-worker `concurrency`, built-in retries/backoff, and `job.updateProgress()`.
- **Pros:** First-class NestJS package; excellent worker DX (concurrency, retry/backoff, progress events that feed TD-07's status model); matches the arch diagram's dedicated MQ; huge community + `bull-board` UI for debugging.
- **Cons:** Adds Redis as a new Compose service and a new operational dependency.

### Option B: pg-boss (PostgreSQL-backed)
- Job queue built on the Postgres already in the stack. No new broker.
- **Pros:** Zero new infra — reuses the existing DB; transactional job enqueue alongside the video row; simpler ops for a small project.
- **Cons:** No official NestJS module (thinner integration, more glue code); Postgres as a queue has lower throughput ceilings and adds load to the primary DB; fewer worker ergonomics than BullMQ; diverges from the "dedicated MQ" in the arch diagram.

### Option C: RabbitMQ (`@nestjs/microservices` / amqplib)
- Dedicated AMQP broker.
- **Pros:** Mature broker; strong routing/fan-out; Nest microservices transport exists.
- **Cons:** Heaviest to operate for a single job type; more concepts (exchanges, bindings) than needed; weaker per-job progress/retry ergonomics than BullMQ for this use case.

**Recommendation:** Option A — BullMQ + Redis. Its `WorkerHost`/progress model maps directly onto the processing-status lifecycle (TD-07), it is the Nest-idiomatic choice, and it matches the documented architecture. Honest trade-off: if avoiding a Redis dependency is a hard requirement, Option B (pg-boss) is the strongest fallback since Postgres is already present — at the cost of NestJS integration polish.

**Decision:** Option A — BullMQ + Redis via `@nestjs/bullmq`. The `WorkerHost`/progress model backs the TD-07 processing-status lifecycle.
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-03: Video Worker Process Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)" and "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** FFmpeg processing needs the `ffmpeg`/`ffprobe` binaries installed and consumes significant CPU. We must decide whether the queue consumer runs as a separate deployable (as the arch diagram's "Video Worker" container suggests) or inside the API process. This shapes `compose.yaml`, the Dockerfile(s), and how code is organized/shared.

**Options:**

### Option A: Separate worker container (own Dockerfile with FFmpeg) consuming the queue
- A second Nest bootstrap (or a Nest standalone app) packaged in an image that installs `ffmpeg`; it registers the BullMQ `@Processor`. The API image stays FFmpeg-free.
- **Pros:** Matches the arch diagram; isolates CPU-heavy work from API latency/availability; independent scaling and restart; keeps the API image slim (no FFmpeg). Shared code (entities, storage service) reused via the same monorepo/`src`.
- **Cons:** A second Compose service + Dockerfile; slightly more bootstrap wiring (which modules the worker loads).

### Option B: In-API processor (same container/process)
- The BullMQ worker runs inside the API process; the API image installs FFmpeg.
- **Pros:** Simplest — one image, one deploy; no extra service.
- **Cons:** CPU-heavy transcodes/thumbnailing contend with request handling; a crashed/blocked worker can degrade the API; API image bloated with FFmpeg; cannot scale worker independently; diverges from the documented architecture.

**Recommendation:** Option A — a dedicated worker service. Phase 03 is precisely where the arch diagram's API/Worker split earns its keep: 10GB-scale ffprobe/thumbnail work must not sit in the API's event loop or image. Share the domain code from the same codebase; only the entrypoint and the FFmpeg base image differ.

**Decision:** Option A — dedicated worker container with its own FFmpeg Dockerfile, consuming the queue (TD-02) and sharing domain code from the same codebase; only the entrypoint and the FFmpeg base image differ from the API.

---

## TD-04: Large-File Upload Protocol (10GB, resumable)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The headline non-functional requirement: upload up to 10GB "sem impacto na performance" and "permita retomar em caso de falha de conexão" (Pontos de Atenção). The chosen handshake lives on both sides — the browser's upload logic and the API's orchestration/validation — so this is one Cross-layer contract, not two.

**Options:**

### Option A: Presigned S3 multipart upload (browser → storage direct)
- API pre-registers the draft video (TD-07), calls `CreateMultipartUpload`, and hands the browser presigned `UploadPart` URLs (batched/lazily). The browser PUTs parts **directly to MinIO/S3**; API only issues URLs and calls `CompleteMultipartUpload`. `ListParts` enables resume after a drop.
- **Pros:** The 10GB stream never transits the API (true "sem impacto na performance"); resume is native to S3 multipart; scales with storage, not API memory; reuses TD-01's SDK.
- **Cons:** Browser must reach the storage host directly → presigned URLs need the public endpoint (Docker networking note); CORS must be configured on the bucket; slightly more client logic (chunking, part tracking).

### Option B: tus resumable protocol (`@tus/server`)
- Run a tus endpoint in the API; the browser uses a tus client for resumable chunked uploads; a tus S3 store streams parts to storage.
- **Pros:** Purpose-built resumable protocol with a mature client; clean pause/resume UX; storage-agnostic.
- **Cons:** Bytes transit the API/tus layer (unless the S3 store is tuned) → more API resource use than Option A; extra server component and protocol to operate; another dependency outside the AWS SDK already chosen in TD-01.

### Option C: Proxy / streaming multipart through the API (busboy)
- Browser POSTs a single `multipart/form-data`; API streams it to storage.
- **Pros:** Simplest client (one request); no direct browser↔storage path.
- **Cons:** No resume (a dropped 10GB upload restarts from zero); the entire stream occupies API I/O for the whole upload — the exact thing "sem impacto na performance" forbids; timeouts/limits at 10GB are painful.

**Recommendation:** Option A — presigned S3 multipart. It is the only option that simultaneously satisfies "no API in the data path" and native resume, and it reuses the TD-01 SDK. Budget one implementation task for the browser-reachable endpoint + bucket CORS (the Docker networking nuance). If a turnkey resumable client UX is valued over API-offload purity, Option B (tus) is the fallback.

**Decision:** Option A — presigned S3 multipart upload, **masked-gateway variant**. NestJS issues presigned part URLs against a **public storage gateway** (a reverse-proxy/gateway endpoint that fronts and hides the internal MinIO/S3 host); the browser uploads parts directly to that masked endpoint. This keeps native resume and keeps the app servers (NestJS *and* Next.js) OUT of the 10GB byte path, while the internal storage host is never exposed to the client.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
**Note:** Refines the stock "browser → storage direct" default per the user's explicit constraint: the browser must never contact the internal storage host (`minio:9000`). Presigned URLs are generated against the public gateway domain, not the internal service host. Requires a reverse-proxy/gateway service fronting storage in Docker Compose + CORS on that public endpoint. Reuses the TD-01 SDK. The **same masked gateway** serves TD-08 media delivery. The app-layer-proxy alternatives (Next.js or NestJS streaming the bytes) were rejected because they would put an app server in the 10GB byte path, conflicting with "upload sem impacto na performance".

---

## TD-05: Unique Public Video Identifier / Short URL

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** "URL curta e única que nunca conflite" (Pontos de Atenção). The public identifier appears in FE routes and shared links and in the API's public read endpoints — a Cross-layer contract. We keep the internal UUID PK (entity convention) and add a separate public identifier for URLs; the question is how to generate it.

**Options:**

### Option A: `nanoid` short slug in a dedicated `public_id` column
- Generate an ~11-char URL-safe id (YouTube-style) stored in an indexed unique `public_id`; UUID stays the internal PK.
- **Pros:** Short, opaque (doesn't leak row counts/order), URL-safe with no encoding, negligible collision risk at this scale; trivial to index.
- **Cons:** ⚠️ **Module-format gotcha** — `nanoid` v4+ is **ESM-only**; NestJS 11 runs CommonJS. Must pin `nanoid@^3` (last reliably-CJS line) or accept an ESM-interop workaround. (context7 shows an internal inconsistency about whether v5 keeps CJS — flagged per `CLAUDE.md`; the safe, unambiguous choice is `nanoid@3`.)

### Option B: `sqids` (encode a sequential counter)
- Reversibly encode a per-table sequence into a short, non-sequential-looking string.
- **Pros:** No RNG/collision handling; CJS-friendly; decodable back to the id.
- **Cons:** Reversible → with the alphabet/salt known, ordering can leak; ties the public id to a sequence column; slightly more setup than a random slug.

### Option C: Raw UUID in the URL
- Expose the existing UUID PK directly.
- **Pros:** Zero new column or dependency.
- **Cons:** Long and ugly (36 chars) — fails "URL curta"; leaks the internal PK; not the desired short-link UX.

**Recommendation:** Option A — `nanoid` `public_id`, pinned to `nanoid@^3` for CommonJS compatibility. It best matches "curta e única" with the strongest opacity. If adding a CJS-pinned dependency is undesirable, Option B (`sqids`) is a clean, CJS-native fallback — accept its reversibility.

**Decision:** Option A — `nanoid` short slug stored in a dedicated `public_id` column, pinned to `nanoid@^3` for CommonJS compatibility.
**Libraries:** nanoid@^3

---

## TD-06: Video Processing Tooling & Scope (FFmpeg)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)" and "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker (TD-03) must extract duration/metadata (ffprobe) and generate a thumbnail from a frame (ffmpeg). We choose how to invoke FFmpeg from Node. Per the scope boundary above, processing = metadata + thumbnail (+ optional faststart remux for progressive streaming); **no ABR/HLS transcoding**.

**Options:**

### Option A: `fluent-ffmpeg` wrapper
- Fluent JS API over `ffmpeg`/`ffprobe` (`.screenshots()` for thumbnails, `.ffprobe()` for metadata).
- **Pros:** Readable, well-known API; thumbnail/screenshot helpers reduce boilerplate; abundant examples.
- **Cons:** ⚠️ Maintenance is slow/stalled (long gaps between releases); still depends on FFmpeg binaries being installed in the worker image (TD-03).

### Option B: Direct `child_process` / `execa` invoking `ffmpeg` + `ffprobe`
- Call the binaries directly, parse `ffprobe -print_format json` output.
- **Pros:** No wrapper dependency (only the binaries); full control over exact flags; future-proof against wrapper abandonment; easy to log/replay exact commands.
- **Cons:** More boilerplate (arg construction, JSON parsing, error handling); no ready-made screenshot helper.

**Recommendation:** Option A — `fluent-ffmpeg` for its thumbnail/metadata ergonomics, accepting the maintenance caveat (the FFmpeg CLI surface it wraps is stable). If the team prefers zero wrapper risk, Option B (`execa`) is a clean, lean alternative — the flags for duration + single-frame thumbnail are simple. Either way, FFmpeg binaries live in the worker image (TD-03), and the processing scope stays metadata + thumbnail (+ optional faststart), not ABR.

**Decision:** Option B — direct `ffmpeg`/`ffprobe` invocation via `execa` (no `fluent-ffmpeg` wrapper). Processing scope stays metadata (duration) + single-frame thumbnail (+ optional faststart), NOT adaptive-bitrate. FFmpeg/ffprobe binaries live in the worker image (TD-03).
**Libraries:** execa@^5
**Note:** `execa` pinned to `^5` — the last CommonJS-compatible major (v6+ is ESM-only) — consistent with the project's CJS constraint that also drove `nanoid@^3` in TD-05. Node's built-in `child_process` (promisified `spawn`) is the zero-dependency alternative within this option if the team prefers no wrapper at all. Diverged from the recommendation (`fluent-ffmpeg`) at the user's request.

---

## TD-07: Video Lifecycle & Processing-Status Model

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" and "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A draft video row is created when upload starts, transitions through processing, and becomes ready (or failed). The status values are written by the worker, exposed by the API DTO, and read by the FE to show "processing…/ready". The FE also needs to learn when processing finishes. The status vocabulary + the readiness-signaling transport are one Cross-layer contract.

**Options:**

### Option A: Status enum + client polling `GET /videos/:id`
- Statuses e.g. `draft → uploading → processing → ready | failed`. Worker updates the row; FE polls the video resource until `ready`/`failed`.
- **Pros:** No new transport; trivial to implement and cache; processing is minutes-scale so a modest poll interval is fine; works through any proxy; easy to test.
- **Cons:** Slight latency to reflect completion; a few redundant requests while processing.

### Option B: Status enum + Server-Sent Events (SSE)
- FE subscribes to an SSE stream that pushes status transitions.
- **Pros:** Near-instant updates; one long-lived connection instead of polling.
- **Cons:** New endpoint/transport + connection lifecycle to manage; harder through some proxies; overkill for a minutes-scale, one-shot transition.

### Option C: Status enum + WebSocket
- Bi-directional socket pushes updates.
- **Pros:** Real-time; reusable for future features.
- **Cons:** Heaviest (gateway, auth on socket, scaling/sticky sessions); unjustified for a single readiness transition in this phase.

**Recommendation:** Option A — status enum + polling. It fully satisfies the capability with no new transport and aligns with the BullMQ progress model (TD-02) exposed via the video DTO. Revisit SSE/WebSocket only if a future phase needs live progress bars; for Phase 03, polling a ready/failed flag is sufficient and simplest.

**Decision:** Option B — status enum on the `Video` entity + Server-Sent Events (SSE) as the push channel for processing-status changes.
**Note:** NestJS exposes SSE natively via the `@Sse()` decorator returning an RxJS `Observable` (RxJS is already a NestJS dependency) — no new runtime library. The status enum still backs a `GET /videos/:id` DTO field for one-shot/non-streaming reads; SSE pushes live status transitions (BullMQ progress from TD-02 feeds the event stream). Diverged from the recommendation (polling) at the user's request.

---

## TD-08: Media Delivery — Streaming & Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário"

**Context:** Playback must start without a full download (HTTP Range) and users must be able to download the file. Both are the same underlying question — does the byte stream flow through the API or straight from storage — so they are one Cross-layer decision. (Public/unlisted access control is a Phase 05 concern; this TD decides the delivery mechanism, not the visibility policy.)

**Options:**

### Option A: Presigned GET URLs direct from storage (Range + attachment)
- API returns a short-lived presigned `GetObject` URL. Streaming uses the storage's native HTTP Range support; download uses the same with `response-content-disposition=attachment`.
- **Pros:** API stays out of the data path (consistent with TD-01/TD-04); storage handles Range/partial content natively; scales with storage; one mechanism covers both stream and download via response overrides.
- **Cons:** URL host must be browser-reachable (Docker networking note); presigned URLs expire (FE refreshes as needed); fine-grained per-request access logic must be encoded at URL-issue time.

### Option B: API proxy with Range support
- Nest streams bytes from storage to the client, honoring `Range`/`206 Partial Content`, and sets `Content-Disposition` for downloads.
- **Pros:** Full control at request time (auth, logging, throttling); no browser↔storage exposure; no URL expiry to manage.
- **Cons:** Every byte of every stream/download transits the API — directly contradicts the "sem impacto na performance" posture chosen in TD-01/TD-04; API becomes a bandwidth bottleneck; Range proxying is fiddly to get exactly right.

### Option C: Hybrid (proxy for access-gated, presigned for public)
- Proxy when a request needs live gating; presign otherwise.
- **Pros:** Flexible per-resource.
- **Cons:** Two code paths to build and test; premature for Phase 03 where visibility rules aren't defined yet (Phase 05).

**Recommendation:** Option A — presigned direct-from-storage for both streaming and download. It keeps the API out of the 10GB data path (coherent with TD-01/TD-04), gets Range streaming for free from the storage layer, and covers download via `response-content-disposition`. When Phase 05 introduces public/unlisted rules, gating moves to the presigned-URL-issuing endpoint.

**Decision:** Option A — presigned GET URLs for both streaming (HTTP Range) and download (`response-content-disposition`), issued against the **same public masked storage gateway as TD-04** (browser → gateway → storage). Range streaming comes free from the storage layer; the internal storage host stays hidden and the app servers stay OUT of the 10GB byte path.
**Libraries:** @aws-sdk/s3-request-presigner
**Note:** Consistent with the TD-04 masked-gateway decision — the browser never contacts the internal storage host; presigned GET URLs target the public gateway endpoint, not `minio:9000`. When Phase 05 introduces public/unlisted rules, gating moves to the presigned-URL-issuing endpoint. Reuses the TD-01 SDK.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Backend & SDK | A — MinIO via `@aws-sdk/client-s3` (S3-swappable) | A |
| TD-02 | Backend | Background-Job / Message-Queue System | A — BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-03 | Backend | Video Worker Process Topology | A — separate worker container (FFmpeg) | A |
| TD-04 | Cross-layer | Large-File Upload Protocol (10GB, resumable) | A — presigned S3 multipart (browser → storage) | A — masked-gateway variant |
| TD-05 | Cross-layer | Unique Public Video Identifier / Short URL | A — `nanoid` `public_id` (pin `nanoid@^3`, CJS) | A |
| TD-06 | Backend | Video Processing Tooling & Scope (FFmpeg) | A — `fluent-ffmpeg` (metadata + thumbnail; no ABR) | B — execa/child_process (no wrapper) |
| TD-07 | Cross-layer | Video Lifecycle & Processing-Status Model | A — status enum + client polling | B — status enum + SSE |
| TD-08 | Cross-layer | Media Delivery — Streaming & Download | A — presigned GET (Range + attachment) | A — via masked gateway |
