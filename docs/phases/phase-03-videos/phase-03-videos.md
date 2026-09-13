---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-06T18:17:09-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-06T18:20:56-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-06T18:15:08-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-06T11:41:23-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video upload-and-processing backend in `nestjs-project`: resumable presigned multipart upload of files up to 10GB through a masked storage gateway (browser → gateway → MinIO/S3, with the API kept out of the byte path), automatic draft pre-registration when an upload starts, background FFmpeg processing (duration + metadata extraction and single-frame thumbnail generation) on a dedicated worker container consuming a BullMQ/Redis queue, a unique public URL per video (`nanoid` `public_id`), live processing-status exposure (status enum backing `GET /videos/:id` plus an SSE channel), and Range-based streaming plus user download via presigned GET on the same masked gateway.

---

## Step Implementations

### SI-03.1 — Infra: storage, fila e worker (Docker Compose + config)

**Description:** Provisiona os serviços de object storage, fila e worker no Docker Compose e as configurações namespaced correspondentes, sem lógica de negócio.

**Technical actions:**

1. Adicionar ao `docker-compose.yml` os serviços `minio`, `redis`, um gateway de storage (reverse-proxy público — ex.: nginx/Caddy — que mascara `minio:9000`) e `video-worker`, com as variáveis no `.env` (credenciais MinIO, bucket, URL pública do gateway, host/porta Redis) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
2. Criar `src/config/storage.config.ts` com `registerAs('storage', …)` — endpoint interno (`minio:9000`), endpoint público do gateway, bucket, região, credenciais e `forcePathStyle: true` (per `phase-03-videos/TD-01`)
3. Criar `src/config/queue.config.ts` com `registerAs('queue', …)` — host/porta do Redis via service name `redis` (per `phase-03-videos/TD-02`)
4. Estender o schema Joi em `src/config/env.validation.ts` para validar as novas variáveis de storage e fila (per `## Inherited Conventions`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `minio`, `redis`, `video-worker` e o gateway com status `running`
- A aplicação aborta o bootstrap com erro de validação Joi quando falta uma variável obrigatória de storage ou fila
- `storage.config` expõe o endpoint interno do MinIO e o endpoint público do gateway como valores configuráveis independentes

---

### SI-03.2 — Entidade Video + migration

**Description:** Cria a entidade `Video` (rascunho, status, chaves de storage, metadados) e a migration correspondente, incluindo o lado recíproco em `Channel`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com a entidade `Video` e o enum `video_status` (`draft|uploading|processing|ready|failed`), colunas conforme `## Technical Specifications → Data Model` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`)
2. Adicionar `@OneToMany(() => Video, (video) => video.channel)` em `src/channels/entities/channel.entity.ts` — ambos os lados da relação (per `.claude/rules/nestjs-entities.md`)
3. Gerar a migration TypeORM da tabela `videos` — enum, FK `channel_id → channels.id`, índice único em `public_id`, índices em `channel_id` e `status` (per `## Inherited Conventions`: `synchronize: false`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, default `status='draft'`, unicidade de `public_id`, FK `channel_id` | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir um `Video` sem `status` persiste com `status='draft'`
- Inserir dois `Video` com o mesmo `public_id` viola a constraint de unicidade
- Inserir um `Video` com `channel_id` inexistente viola a FK
- `size_bytes` aceita valores acima de 2^31 (coluna `bigint`, cobrindo os 10 GB)

---

### SI-03.3 — StorageService (adapter S3/MinIO multipart + presign)

**Description:** Encapsula o acesso ao object storage via `@aws-sdk/client-s3` — multipart upload e geração de URLs presignadas contra o gateway público.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e inicializar o `S3Client` a partir de `storage.config` (endpoint interno para control-plane; `forcePathStyle: true`) (per `phase-03-videos/TD-01`)
2. Criar `src/storage/storage.service.ts` com `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload` e `abortMultipartUpload` (per `phase-03-videos/TD-04`)
3. Adicionar em `storage.service.ts` os métodos `presignGet` (streaming com Range) e `presignDownload` (`ResponseContentDisposition: attachment`), gerando URLs contra o endpoint **público** do gateway (per `phase-03-videos/TD-08`)
4. Exportar `StorageModule` e registrá-lo em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO local real): ciclo multipart create→presign-part→complete→abort; `presignGet` preserva Range e `presignDownload` inclui content-disposition | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `createMultipartUpload` retorna um `uploadId` e `completeMultipartUpload` com os ETags monta o objeto no bucket
- Uma URL de `presignGet` serve o objeto sob requisição HTTP Range (206 Partial Content)
- Uma URL de `presignDownload` responde com header `content-disposition: attachment`
- As URLs presignadas apontam para o host público do gateway, nunca para `minio:9000` (per `phase-03-videos/TD-04`)

---

### SI-03.4 — QueueModule (BullMQ + Redis)

**Description:** Registra a conexão BullMQ e a fila `video-processing` para produtores (API) e consumidores (worker).

**Technical actions:**

1. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` (conexão via `queue.config`, service name `redis`) e `BullModule.registerQueue({ name: 'video-processing' })` (per `phase-03-videos/TD-02`)
2. Exportar a fila registrada e importar `QueueModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: teste de compilação do módulo | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `QueueModule` compila e disponibiliza a fila `video-processing` para injeção via `@InjectQueue('video-processing')`
- A conexão usa o service name `redis` (nunca `localhost`), per convenção Docker do projeto

---

### SI-03.5 — Exceções de domínio de vídeo + guard de propriedade

**Description:** Cria as exceções de domínio (mapeadas pelo Custom Domain Exception Filter herdado) e o guard que autoriza ações restritas ao dono do vídeo.

**Technical actions:**

1. Criar `src/videos/exceptions/` com as exceções de domínio (`VideoNotFound` → 404 `VIDEO_NOT_FOUND`; `ForbiddenNotOwner` → 403 `FORBIDDEN_NOT_OWNER`; `UploadNotInProgress` → 409 `UPLOAD_NOT_IN_PROGRESS`; `FileTooLarge` → 400 `FILE_TOO_LARGE`; `UnsupportedMediaType` → 415 `UNSUPPORTED_MEDIA_TYPE`; `InvalidParts` → 400 `INVALID_PARTS`; `VideoNotReady` → 409 `VIDEO_NOT_READY`) conforme `## Technical Specifications → Error Catalog` (per `phase-02-auth/TD-07`)
2. Criar `src/videos/guards/video-owner.guard.ts` — resolve o vídeo por `publicId` (via repositório), carrega o `Channel` e compara `channel.user_id` ao usuário autenticado; lança `ForbiddenNotOwner`/`VideoNotFound` (per `## Technical Specifications → Authorization Matrix`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoOwnerGuard` | Unit: dono → allow; não-dono → `FORBIDDEN_NOT_OWNER`; inexistente → `VIDEO_NOT_FOUND` (mock repo) | `src/videos/guards/video-owner.guard.spec.ts` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- Uma ação restrita executada pelo dono do canal do vídeo é autorizada
- A mesma ação por um usuário autenticado que não é dono retorna 403 `FORBIDDEN_NOT_OWNER`
- A mesma ação sobre um `publicId` inexistente retorna 404 `VIDEO_NOT_FOUND`

---

### SI-03.6 — VideosService: rascunho + orquestração de upload

**Description:** Implementa a lógica de negócio do upload — pré-cadastro do rascunho, geração de `public_id`, handshake multipart e enfileiramento do processamento.

**Technical actions:**

1. Criar `src/videos/videos.module.ts` importando `StorageModule`, `QueueModule` e `TypeOrmModule.forFeature([Video])`
2. Criar `src/videos/videos.service.ts` com geração de `public_id` via `nanoid` `customAlphabet` + retry em colisão (per `phase-03-videos/TD-05`)
3. Implementar `createDraft` (pré-cadastro `status='draft'` + `createMultipartUpload`) e `issuePartUrls` (presign das partes solicitadas) (per `phase-03-videos/TD-04`)
4. Implementar `completeUpload` (completa o multipart, `status='processing'`, enfileira `video-processing` via `@InjectQueue`) e `abortUpload` (aborta o multipart, marca `failed`) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: geração/retry de `public_id`, transições de status, enfileiramento (mock repo/storage/queue) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: persistência do rascunho e unicidade de `public_id` sob colisão (DB real) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `createDraft` persiste um `Video` com `status='draft'` e `public_id` único, retornando o `uploadId`
- Uma colisão de `public_id` é resolvida por retry — nunca resulta em erro ao chamador
- `completeUpload` transiciona `status` para `processing` e enfileira exatamente um job `video-processing` com `{ videoId }`
- `abortUpload` transiciona o vídeo para `failed` e é idempotente

---

### SI-03.7 — Controller de upload + DTOs (HTTP wiring)

**Description:** Expõe o handshake de upload via HTTP com validação class-validator, JWT auth guard + guard de dono e documentação OpenAPI.

**Route:** POST /videos; POST /videos/:publicId/upload/part-urls; POST /videos/:publicId/upload/complete; DELETE /videos/:publicId/upload
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`

**Technical actions:**

1. Criar os DTOs `create-video.dto.ts`, `part-urls.dto.ts` e `complete-upload.dto.ts` com validações class-validator conforme `## Technical Specifications → API Contracts → Validation Rules` (per `phase-02-auth/TD-06`)
2. Criar `src/videos/videos.controller.ts` com as 4 rotas de upload, aplicando o JWT auth guard herdado (`phase-02-auth/TD-03`) e o `VideoOwnerGuard` (per `## Technical Specifications → Authorization Matrix`, `phase-03-videos/TD-04`)
3. Anotar rotas e DTOs com decorators `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`)

**Tests:** _(empty — comportamento HTTP/validação/guard é E2E, autorado por /plan-test-specs; ver **Test Specs**)_

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `POST /videos` autenticado com corpo válido retorna 201 com `publicId`, `uploadId` e `status='draft'`
- `POST /videos` com `sizeBytes` acima de 10 GB retorna 400 `FILE_TOO_LARGE`
- `POST /videos` com `contentType` fora de `video/*` retorna 415 `UNSUPPORTED_MEDIA_TYPE`
- `POST /videos/:publicId/upload/complete` por um usuário não-dono retorna 403 `FORBIDDEN_NOT_OWNER`
- Qualquer rota de upload sem token de acesso retorna 401

---

### SI-03.8 — Leitura do vídeo + status SSE

**Description:** Expõe a leitura do vídeo (com regras de visibilidade por status) e o canal SSE de status ao vivo do processamento.

**Route:** GET /videos/:publicId; GET /videos/:publicId/status (SSE)
**Test Specs:** see `nestjs-project/specs/videos-read.plan.md`

**Technical actions:**

1. Adicionar `getByPublicId` em `videos.service.ts` com regra de visibilidade — anônimo/não-dono vê apenas `ready`; dono vê qualquer status (per `## Technical Specifications → Authorization Matrix`)
2. Criar `src/videos/dto/video-response.dto.ts` (`publicId`, `title`, `status`, `progress`, `durationSeconds`, `metadata`, `thumbnailUrl`, `createdAt`) (per `phase-03-videos/TD-07`)
3. Criar o handler `@Sse('videos/:publicId/status')` retornando `Observable<MessageEvent>` alimentado por `QueueEvents` da BullMQ, com `finalize()` no disconnect (per `phase-03-videos/TD-07`, `phase-03-videos/TD-02`)
4. Adicionar `GET /videos/:publicId` e o SSE ao `videos.controller.ts` com decorators `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getByPublicId` | Unit: visibilidade (anônimo vê só `ready`; dono vê `draft/processing/failed`) | `src/videos/videos.service.spec.ts` |

_(O E2E de `GET /videos/:publicId` e do stream SSE é autorado por /plan-test-specs — ver **Test Specs**.)_

**Dependencies:** SI-03.6, SI-03.4, SI-03.5

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo `ready` por usuário anônimo retorna 200 com o DTO público
- `GET /videos/:publicId` de um vídeo `processing` por não-dono retorna 404 `VIDEO_NOT_FOUND`
- `GET /videos/:publicId/status` emite eventos `text/event-stream` com `{ status, progress }` e encerra o stream em `ready`/`failed`
- `GET /videos/:publicId/status` sem token de acesso retorna 401

---

### SI-03.9 — Streaming e download (delivery)

**Description:** Resolve URLs presignadas no gateway e redireciona (302) para streaming com Range e para download com attachment, mantendo a API fora do caminho dos bytes.

**Route:** GET /videos/:publicId/stream; GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`

**Technical actions:**

1. Adicionar `getStreamUrl` e `getDownloadUrl` em `videos.service.ts` — exigem `status='ready'` (senão lançam `VideoNotReady`), delegando a `StorageService.presignGet`/`presignDownload` (per `phase-03-videos/TD-08`)
2. Adicionar `GET /videos/:publicId/stream` ao controller retornando 302 para a URL presignada Range-capable (per `phase-03-videos/TD-08`)
3. Adicionar `GET /videos/:publicId/download` retornando 302 para a URL presignada com `content-disposition: attachment` (per `phase-03-videos/TD-08`)
4. Anotar as rotas com decorators `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (stream/download) | Unit: `ready` → URL presignada; não-`ready` → `VIDEO_NOT_READY` (mock storage) | `src/videos/videos.service.spec.ts` |

_(O E2E dos redirects 302 é autorado por /plan-test-specs — ver **Test Specs**.)_

**Dependencies:** SI-03.6, SI-03.3, SI-03.5

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de um vídeo `ready` retorna 302 com `Location` para o host público do gateway
- `GET /videos/:publicId/stream` de um vídeo não-`ready` retorna 409 `VIDEO_NOT_READY`
- `GET /videos/:publicId/download` de um vídeo `ready` retorna 302 para uma URL com `content-disposition: attachment`
- `GET /videos/:publicId/stream` de um `publicId` inexistente retorna 404 `VIDEO_NOT_FOUND`

---

### SI-03.10 — Video worker: processor + entrypoint

**Description:** Container dedicado que consome a fila e processa o vídeo com FFmpeg — extração de duração/metadados e geração de thumbnail — atualizando o status.

**Technical actions:**

1. Criar `src/videos/processors/video-processing.processor.ts` (`@Processor('video-processing')` estendendo `WorkerHost`) que lê o source do storage e roda `ffprobe`/`ffmpeg` via `execa` (form função `execa(file, args[])`, CJS) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-03`)
2. Persistir `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at` e `status='ready'`; em erro, `@OnWorkerEvent('failed')` marca `status='failed'`; reportar `job.updateProgress` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
3. Criar o entrypoint `src/main.worker.ts` que sobe apenas o módulo consumidor da fila (sem servidor HTTP) (per `phase-03-videos/TD-03`)
4. Criar o `Dockerfile` do worker com imagem base contendo FFmpeg, apontando o comando para o entrypoint do worker (per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration (ffmpeg/ffprobe reais sobre um fixture): extrai duração/metadados, gera thumbnail, transiciona status | `src/videos/processors/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Um job `video-processing` sobre um vídeo válido persiste `duration_seconds`, `metadata` e `thumbnail_key` e transiciona `status` para `ready`
- Um source inválido/corrompido transiciona `status` para `failed` sem derrubar o worker
- O processamento é idempotente — reexecutar o job sobre o mesmo source produz o mesmo resultado final
- O progresso do job é reportado durante o processamento (observável via `QueueEvents`)

---

## Technical Specifications

### Data Model

#### Video (new entity — `videos` table)

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`@PrimaryGeneratedColumn('uuid')`) — internal identifier, never exposed in URLs |
| public_id | varchar(16) | unique, not null — opaque short id from `nanoid` (per TD-05); the sole video identifier in public URLs |
| channel_id | uuid | FK → `channels.id`, not null — owning channel (ownership derives through `Channel.user_id`) |
| title | varchar(255) | nullable — draft title (full editing is Phase 04 scope) |
| original_filename | varchar(255) | nullable — uploaded file name |
| content_type | varchar(128) | nullable — uploaded MIME type (must match `video/*`) |
| size_bytes | bigint | nullable — declared upload size; `bigint` required for the 10 GB ceiling (per TD-04) |
| status | `video_status` enum | not null, default `draft` (per TD-07) |
| storage_key | varchar(512) | nullable — object key of the source video in storage (per TD-01) |
| thumbnail_key | varchar(512) | nullable — object key of the generated thumbnail (per TD-06) |
| duration_seconds | integer | nullable — extracted via `ffprobe` (per TD-06) |
| metadata | jsonb | nullable — raw `ffprobe` metadata (codecs, resolution, bitrate, framerate) (per TD-06) |
| upload_id | varchar(255) | nullable — S3/MinIO multipart `UploadId` while an upload is in progress (per TD-04); cleared on complete/abort |
| processed_at | timestamptz | nullable — set when background processing finishes |
| created_at | timestamptz | default now() (`@CreateDateColumn`) |
| updated_at | timestamptz | default now() (`@UpdateDateColumn`) |

**Enum `video_status`** (derived from the lifecycle capabilities + TD-07):
- `draft` — pre-registered automatically when the upload is initiated ("pré-cadastro … ao iniciar o upload"); default state.
- `uploading` — multipart transfer in progress (optional intermediate; set when part URLs are first issued).
- `processing` — upload completed; queued/being processed by the worker.
- `ready` — processing succeeded; streamable/downloadable.
- `failed` — upload aborted or processing failed (terminal).

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (many-to-one via `channel_id`). The reciprocal `@OneToMany(() => Video, (video) => video.channel)` must be added to the existing `Channel` entity (`src/channels/entities/channel.entity.ts`) — both sides defined per `.claude/rules/nestjs-entities.md`.

**Indexes:** unique on `public_id`; non-unique index on `channel_id`; non-unique index on `status` (worker/listing filters).

**No separate upload/part-tracking entity.** Per TD-04, per-part `ETag`s are collected client-side during the browser→gateway transfer and submitted on the complete call; the API persists only the multipart `upload_id` on `Video` to broker completion/abort. The `Video` entity requires a TypeORM migration (per `.claude/rules/nestjs-entities.md`; `synchronize: false` is the inherited convention).

**Column casing:** DB columns are snake_case (matching the existing `Channel`/`User` entities: `user_id`, `created_at`); API JSON fields are camelCase (`publicId`, `uploadId`, `sizeBytes`, `durationSeconds`, `thumbnailUrl`).

### API Contracts

_All request/response bodies use camelCase JSON. DTOs are validated with the inherited `class-validator` + `class-transformer` stack (phase-02-auth/TD-06) and documented with `@nestjs/swagger` (openapi-docs-nestjs/TD-01). Error responses use the inherited Custom Domain Exception Filter shape `{ statusCode, error, message }` (phase-02-auth/TD-07) — the `error` field carries the domain code from the Error Catalog. The public path identifier is `publicId` (per TD-05); the internal uuid `id` is never exposed in URLs._

#### POST /videos (SI-03.7)

Pre-registers a draft video and initiates the masked-gateway multipart upload (per TD-04, TD-05, TD-07). Creates the `Video` (status `draft`), generates `publicId`, and calls `CreateMultipartUpload` against storage.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access token> (per inherited phase-02-auth JWT auth)

**Request body:**
- filename: string, required — max 255
- contentType: string, required — must match `video/*`
- sizeBytes: number, required — integer, 1..10737418240 (10 GB)
- title: string, optional — max 255

**Response 201:**
- publicId: string
- status: string — `draft`
- uploadId: string — storage multipart `UploadId`
- partSize: number — recommended part size in bytes
- partCount: number — recommended number of parts for `sizeBytes`

**Error responses:**
- 401 (unauthenticated): missing/invalid access token
- 415 UNSUPPORTED_MEDIA_TYPE: `contentType` is not `video/*`
- 400 FILE_TOO_LARGE: `sizeBytes` exceeds the 10 GB ceiling
- 400 validation error: body fails schema validation

---

#### POST /videos/:publicId/upload/part-urls (SI-03.7)

Issues presigned `UploadPart` URLs (against the public gateway host, per TD-04) for the requested part numbers. Supports resume by requesting URLs only for missing parts. The browser PUTs each part directly to the gateway — the API stays out of the byte path.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access token>

**Request body:**
- partNumbers: number[], required — each integer 1..10000 (S3 multipart limit)

**Response 200:**
- parts: array of `{ partNumber: number, url: string }` — presigned gateway URLs
- expiresAt: string (ISO-8601) — expiry of the presigned URLs

**Error responses:**
- 401 (unauthenticated)
- 403 FORBIDDEN_NOT_OWNER: authenticated user does not own the video's channel
- 404 VIDEO_NOT_FOUND: `publicId` does not resolve
- 409 UPLOAD_NOT_IN_PROGRESS: video is not in `draft`/`uploading` state
- 400 validation error

---

#### POST /videos/:publicId/upload/complete (SI-03.7)

Completes the multipart upload (`CompleteMultipartUpload` with the client-collected ETags, per TD-04), transitions the video to `processing`, and enqueues the `video-processing` job (per TD-02).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access token>

**Request body:**
- parts: array of `{ partNumber: number, eTag: string }`, required — ordered part manifest collected by the browser

**Response 200:**
- publicId: string
- status: string — `processing`

**Error responses:**
- 401 (unauthenticated)
- 403 FORBIDDEN_NOT_OWNER
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_NOT_IN_PROGRESS
- 400 INVALID_PARTS: parts list missing/malformed or rejected by storage
- 400 validation error

---

#### DELETE /videos/:publicId/upload (SI-03.7)

Aborts an in-progress multipart upload (`AbortMultipartUpload`, per TD-04) and marks the draft `failed` (or deletes it). Idempotent cleanup.

**Request headers:**
- Authorization: Bearer <access token>

**Response 204:** No content.

**Error responses:**
- 401 (unauthenticated)
- 403 FORBIDDEN_NOT_OWNER
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:publicId (SI-03.8)

Returns the video DTO, including live processing status (per TD-07). Anonymous callers see only `ready` videos; the owner sees any status (draft/processing/failed included).

**Request headers:**
- Authorization: Bearer <access token> — optional (owner context)

**Response 200:**
- publicId: string
- title: string | null
- status: string — one of `draft|uploading|processing|ready|failed`
- progress: number | null — 0..100 while `processing` (from BullMQ job progress, per TD-02)
- durationSeconds: number | null
- metadata: object | null — ffprobe-derived (codecs, resolution, bitrate, framerate)
- thumbnailUrl: string | null — presigned gateway GET URL for the thumbnail
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` does not resolve, or the video is not `ready` and the caller is not the owner (existence hidden)

---

#### GET /videos/:publicId/status (SI-03.8)

Server-Sent Events channel pushing live status/progress transitions (per TD-07, `@Sse()` returning `Observable<MessageEvent>`; driven by BullMQ `QueueEvents`, per TD-02). Owner-only.

**Request headers:**
- Accept: text/event-stream
- Authorization: Bearer <access token>

**Response 200:** `Content-Type: text/event-stream`. Each event `data` is JSON `{ status: string, progress: number }`. The stream closes (via RxJS `finalize`) when processing reaches `ready`/`failed` or the client disconnects.

**Error responses:**
- 401 (unauthenticated)
- 403 FORBIDDEN_NOT_OWNER
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:publicId/stream (SI-03.9)

Resolves to a Range-capable presigned GET URL on the masked gateway and 302-redirects to it (per TD-08). The browser's subsequent Range requests hit the gateway directly, keeping the API out of the byte path. Anonymous, `ready` videos only.

**Response 302:** `Location: <presigned gateway GET URL>` (Range preserved per the SDK, see library-refs). No body.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: video status is not `ready`

---

#### GET /videos/:publicId/download (SI-03.9)

Resolves to a presigned GET URL with `ResponseContentDisposition: attachment; filename="…"` and 302-redirects to it (per TD-08). Anonymous, `ready` videos only.

**Response 302:** `Location: <presigned gateway GET URL with attachment disposition>`. No body.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### Validation Rules — Videos

- `filename`: required string, 1..255 chars.
- `contentType`: required string, must match `video/*` (MIME allowlist).
- `sizeBytes`: required integer, 1..10737418240 (10 GB).
- `title`: optional string, max 255.
- `partNumbers`: required non-empty array of integers, each 1..10000.
- `parts`: required non-empty array of `{ partNumber: integer 1..10000, eTag: non-empty string }`.
- `publicId` (path): string matching the nanoid alphabet/length (per TD-05).

### Authorization Matrix

_Auth is enforced with the inherited JWT auth guard from phase-02-auth (TD-03). **Owner** = the authenticated user whose channel (`Channel.user_id === user.id`) owns the video (`Video.channel_id === channel.id`); enforced by a dedicated video-ownership guard (SI-03.5). Anonymous watch is a first-class case — the project overview allows anonymous users to watch freely._

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✓ (creates under own channel) | ✓ |
| POST /videos/:publicId/upload/part-urls | ✗ | ✗ | ✓ |
| POST /videos/:publicId/upload/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:publicId/upload | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (any status) |
| GET /videos/:publicId/status (SSE) | ✗ | ✗ | ✓ |
| GET /videos/:publicId/stream | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (`ready` only) |
| GET /videos/:publicId/download | ✓ (`ready` only) | ✓ (`ready` only) | ✓ (`ready` only) |

_Non-owner / anonymous access to a non-`ready` video returns 404 (existence hidden) rather than 403, per the `GET /videos/:publicId` contract above._

### Error Catalog

_Wire format is the inherited Custom Domain Exception Filter (phase-02-auth/TD-07): `{ statusCode, error, message }`. The `error` column below is the machine-readable domain code carried in that `error` field. Validation failures (400) keep the framework's class-validator message list._

| error | HTTP | Trigger |
|-------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` does not resolve, or a non-`ready` video is requested by a non-owner (existence hidden) |
| FILE_TOO_LARGE | 400 | `sizeBytes` exceeds the 10 GB ceiling on `POST /videos` |
| UNSUPPORTED_MEDIA_TYPE | 415 | `contentType` is not `video/*` |
| UPLOAD_NOT_IN_PROGRESS | 409 | part-urls / complete / abort called on a video not in `draft`/`uploading` state |
| INVALID_PARTS | 400 | complete called with a missing/malformed part manifest, or storage rejects the parts |
| VIDEO_NOT_READY | 409 | stream / download requested for a video whose status is not `ready` |
| FORBIDDEN_NOT_OWNER | 403 | an owner-only action attempted by an authenticated non-owner |

### Events/Messages

#### video-processing (queue job)

BullMQ queue `video-processing` on Redis (per TD-02). Enqueued when a multipart upload completes; consumed by the dedicated worker container (per TD-03) which runs FFmpeg tooling (per TD-06).

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` on `POST /videos/:publicId/upload/complete` (per TD-02 / TD-04) — `@InjectQueue('video-processing')`.
**Consumer:** `VideoProcessor extends WorkerHost` in the worker container (per TD-03).
**Trigger:** fires once the browser→gateway multipart upload is completed and the video transitions to `processing`.
**Delivery semantics:** at-least-once (BullMQ) — the processor must be idempotent (re-running ffprobe/ffmpeg + re-uploading the thumbnail on the same source is safe) (per TD-02/TD-03).
**Processing steps (per TD-06, via `execa@^5` invoking `ffprobe`/`ffmpeg`):** (1) read the source object from storage; (2) `ffprobe` → duration + metadata JSON; (3) `ffmpeg` → single-frame thumbnail; (4) upload the thumbnail to storage (`thumbnail_key`); (5) persist `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at`, set status `ready`. On any failure → `@OnWorkerEvent('failed')` sets status `failed`. Progress is reported via `job.updateProgress(n)`.

#### video.status (SSE stream — Cross-layer)

Not a queue — the live push channel exposed by `GET /videos/:publicId/status` (per TD-07). Bridges BullMQ progress/lifecycle events to the browser.

**Payload (per emitted `MessageEvent.data`):**

```json
{ "status": "processing", "progress": 42 }
```

**Producer:** `VideosController` `@Sse()` handler returning `Observable<MessageEvent>` (per TD-07), driven by BullMQ `QueueEvents` (`progress`/`completed`/`failed`, per TD-02).
**Consumer:** browser `EventSource` (FE consumption deferred to `phase-03-videos-frontend`).
**Trigger:** client subscribes while a video is `processing`; emits on each progress/status transition; completes on `ready`/`failed` or client disconnect.
**Delivery semantics:** best-effort, live-only (no replay) — the one-shot `GET /videos/:publicId` DTO field is the durable fallback for missed events.

---

## Dependency Map

```
SI-03.1 (root — infra: storage/queue/worker services + config)
├── SI-03.3 — depends on SI-03.1 (storage.config)
└── SI-03.4 — depends on SI-03.1 (queue.config)

SI-03.2 (root — Video entity + migration)
└── SI-03.5 — depends on SI-03.2 (guard resolves video/channel)

SI-03.6 — depends on SI-03.2 + SI-03.3 + SI-03.4 + SI-03.5
          (service needs entity, storage, queue producer, domain exceptions)
├── SI-03.7 — depends on SI-03.6 (upload controller + DTOs)
├── SI-03.8 — depends on SI-03.6 + SI-03.4 + SI-03.5 (read DTO + SSE off QueueEvents)
└── SI-03.9 — depends on SI-03.6 + SI-03.3 + SI-03.5 (presigned stream/download)

SI-03.10 — depends on SI-03.2 + SI-03.3 + SI-03.4
           (worker: updates entity, reads/writes storage, consumes queue)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: storage, fila e worker (Docker Compose + config)
- [ ] SI-03.2 — Entidade Video + migration
- [ ] SI-03.3 — StorageService (adapter S3/MinIO multipart + presign)
- [ ] SI-03.4 — QueueModule (BullMQ + Redis)
- [ ] SI-03.5 — Exceções de domínio de vídeo + guard de propriedade
- [ ] SI-03.6 — VideosService: rascunho + orquestração de upload
- [ ] SI-03.7 — Controller de upload + DTOs (HTTP wiring)
- [ ] SI-03.8 — Leitura do vídeo + status SSE
- [ ] SI-03.9 — Streaming e download (delivery)
- [ ] SI-03.10 — Video worker: processor + entrypoint

**Full test suites** _(run inside the container per `nestjs-project/CLAUDE.md`)_:

- [ ] Backend unit + integration tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
