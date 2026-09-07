# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/10 completed

### SI-03.1 — Infra: storage, fila e worker (Docker Compose + config)
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - Registered `storage.config` + `queue.config` in AppModule's global `load` array (mirrors the existing config-factory pattern).
  - Extended `env.validation.integration-spec.ts`'s `requiredEnv` fixture with the 3 new required storage vars (`STORAGE_BUCKET`/`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`) so its existing `validate({})` cases stay green — a necessary consequence of adding `.required()` Joi rules (AC #2), not new coverage.
  - `STORAGE_PUBLIC_HOST` holds a full URL (`http://localhost:9000`) so the delivery specs' `Location` assertions (`toContain(publicHost)` / `not.toContain('minio:9000')`) hold.
  - Masking enforced at the topology level: MinIO's API port 9000 is NOT published to the host — only the Caddy gateway (`gateway/Caddyfile`, `Host` passthrough) is host-facing on 9000; a `createbuckets` (minio/mc) one-shot provisions the bucket.
  - `video-worker` is scaffolded as an idle container reusing `Dockerfile.dev` (mirrors nestjs-api). Its FFmpeg image + real worker command are SI-03.10's scope; until then `docker compose up` brings it up idle (AC "running" satisfied), not yet processing.
  - **Stabilization (pre-existing issues, fixed at user request — NOT SI-03.1 regressions).** Two problems surfaced when the user ran `npm test` (parallel) on the shared DB:
    - **Lint debt (150 errors, all in unmodified phase-02 files).** Fixed `channels.service.ts` properly (typed narrowing cast replacing `err as any`) + removed 2 genuinely-unused vars (`auth.service.integration-spec.ts`, `users.service.integration-spec.ts`); relaxed the noisy type-checked family (`no-unsafe-*`, `unbound-method`, `require-await`) for **test globs only** via an `eslint.config.mjs` override — production src stays strict. `npm run lint` → exit 0 (40 non-failing warnings remain).
    - **Migration suite isolation bug + jest hang.** `migrations.integration-spec.ts` `beforeAll` now also drops the leftover `verification_tokens_type_enum` (a `DROP TABLE` doesn't drop its enum type), and `afterAll` wraps `runMigrations` in `try/finally` so `destroy()` always runs (kills the "Jest did not exit" open-handle hang).
  - Killed two redundant `nest start --watch` dev servers running inside the container — they were starving jest and recompiling on every edit (the apparent "stuck" run). Restart with `docker compose exec nestjs-api npm run start:dev` if needed.
  - Verified green (canonical commands): `npm test -- --runInBand` 144/144 (clean exit), `npm run test:e2e` 52/52, `npx tsc --noEmit` 0, `npm run lint` 0 errors.
  - **Decision (user):** keep the parallel jest default — do NOT add `maxWorkers: 1`. Integration/E2E MUST be run with `--runInBand` (plain `npm test` runs the shared-DB integration suites in parallel and contaminates them → FK / enum-collision errors). Canonical: `docker compose exec nestjs-api npm test -- --runInBand` and `npm run test:e2e`.

### SI-03.2 — Entidade Video + migration
- **Status:** completed
- **Tests:** 4 passing (`video.entity.integration-spec.ts` — default `draft`, unique `public_id`, FK `channel_id`, bigint `size_bytes` 10 GB)
- **Observations:**
  - `Video` entity created at `src/videos/entities/video.entity.ts` with the `VideoStatus` enum (`draft|uploading|processing|ready|failed`); snake_case columns matching the existing `Channel`/`User` convention.
  - `size_bytes` typed `string | null` — TypeORM maps `bigint` to string to avoid >2^53 precision loss; the AC-4 test round-trips `'10737418240'`.
  - `created_at`/`updated_at`/`processed_at` use `timestamptz` per the plan's Data Model (the phase-02 entities use plain `timestamp` via bare `@CreateDateColumn`, but the plan Data Model is authoritative and specifies timestamptz).
  - Reciprocal `@OneToMany(() => Video, ...)` added to `Channel` (both sides per `.claude/rules/nestjs-entities.md`).
  - Migration `1788745243630-CreateVideos.ts` generated via TypeORM CLI (not hand-written), applied cleanly; `down()` reverses FK → indexes → table → enum type. The existing `migrations.integration-spec.ts` asserts a hardcoded 2-migration list (`toHaveLength(2)`), so the new migration file does not affect it (out of scope, untouched).
  - No `VideosModule` yet (not in SI-03.2 scope) — the entity is discovered by the data-source `src/**/*.entity.ts` glob for migration generation; module wiring comes in later SIs.

### SI-03.3 — StorageService (adapter S3/MinIO multipart + presign)
- **Status:** completed
- **Tests:** 4 passing (`storage.service.integration-spec.ts` — real MinIO: multipart create→presign-part→PUT→complete→GET; abort; presignGet Range 206; presignDownload content-disposition; all assert URLs never contain `minio:9000`)
- **Observations:**
  - `StorageService` uses **two** `S3Client`s: a control-plane client on the internal endpoint (`minio:9000`) for create/complete/abort multipart, and a presigner client on the **public gateway host** so `getSignedUrl` signs the SigV4 `Host` to match what the browser hits. `getSignedUrl` signs locally (no network), so the presigner client needs no connectivity to the public host.
  - Installed `@aws-sdk/client-s3@^3` + `@aws-sdk/s3-request-presigner@^3` (resolved `^3.1127.0`).
  - `StorageModule` registered in `AppModule` (`storageConfig` was already global from SI-03.1).
  - **Fixed a latent bug in SI-03.1's `gateway/Caddyfile` (surfaced, not silent).** It used `header_up Host {host}`, which strips the port; the SDK signs the `Host` as `<host>:9000` (9000 is non-standard), so MinIO recomputed a different signature → `SignatureDoesNotMatch` (403) on **every** presigned URL through the gateway. This would break production presigned URLs too (browser signs `localhost:9000`, gateway forwards `localhost`). Changed to `header_up Host {hostport}`; verified 200/206 through the gateway. SI-03.1 had no tests to catch this (infra-only); SI-03.3 is the first SI to exercise the presigned-URL contract end-to-end. Requires `docker compose restart storage-gateway` (or a fresh `up`) to reload Caddy.
  - **Test masked-gateway note:** the spec signs against `storage-gateway:9000` (the Compose service name) instead of the prod `localhost:9000` — `localhost` inside the api container resolves to the container itself, whereas `storage-gateway:9000` is container-reachable AND SigV4-consistent (Caddy passes the `Host` through). Still satisfies AC #4 (never `minio:9000`).

### SI-03.4 — QueueModule (BullMQ + Redis)
- **Status:** completed
- **Tests:** 2 passing (`queue.module.spec.ts` — DI compiles; `video-processing` queue resolvable via `getQueueToken` for `@InjectQueue`)
- **Observations:**
  - `QueueModule` uses `BullModule.forRootAsync` (connection from `queue.config` → service name `redis`, injected via `queueConfig.KEY`) + `BullModule.registerQueue({ name: 'video-processing' })`, and re-exports `BullModule` so importers inherit the queue provider. Queue name centralized in `src/queue/queue.constants.ts` (`VIDEO_PROCESSING_QUEUE`), mirroring the `storage.constants.ts` precedent.
  - **Dependency version pin — `@nestjs/bullmq@11.0.5` (not `^12`).** `npm install @nestjs/bullmq` resolved v12.0.0, which is ESM-only (`type: module`, `require` → the same ESM `dist/index.js`). The project's CommonJS Jest/ts-jest stack (default `transformIgnorePatterns: /node_modules/`) can't parse it → `SyntaxError: Unexpected token 'export'`; this would also break the whole e2e suite (AppModule → QueueModule). Pinned to `@nestjs/bullmq@11.0.5` (CJS, matches NestJS 11, peer-supports `bullmq@^6`) instead of doing ESM-transform surgery on both jest configs. Library-refs cited `bullmq` v5; installed `bullmq@^6.3.4` — the `forRootAsync`/`registerQueue`/`InjectQueue`/`WorkerHost` API used here is unchanged across v5→v6.
  - **Installed `ioredis@^5.11.1` explicitly.** `bullmq@6` loads `ioredis` as an *optional* peer (`loadIORedis`); without it, `Queue` construction throws `BullMQ could not load the optional 'ioredis' package` at module-compile time.
  - Module compilation test needs a **global** `ConfigModule` (loads `queueConfig`) for the `forRootAsync` factory's `inject: [queueConfig.KEY]` to resolve (per testing-guide gotcha), and `await moduleRef.close()` in `afterAll` to close the BullMQ/ioredis handle.
  - tsc `--noEmit` = 0 after the dependency changes.

### SI-03.5 — Exceções de domínio de vídeo + guard de propriedade
- **Status:** completed
- **Tests:** 3 passing (`video-owner.guard.spec.ts` — dono → allow; não-dono → `ForbiddenNotOwnerException`; `publicId` inexistente → `VideoNotFoundException`; mock repo via `getRepositoryToken(Video)`)
- **Observations:**
  - As 7 exceções de domínio ficam em um único arquivo `src/videos/exceptions/video.exceptions.ts`, todas estendendo o `DomainException` herdado (`src/common/exceptions/domain.exception.ts`) e mapeadas pelo Custom Domain Exception Filter da fase-02 → `{ statusCode, error, message }`. Códigos exatamente conforme o Error Catalog (`VIDEO_NOT_FOUND`/`FORBIDDEN_NOT_OWNER`/`UPLOAD_NOT_IN_PROGRESS`/`FILE_TOO_LARGE`/`UNSUPPORTED_MEDIA_TYPE`/`INVALID_PARTS`/`VIDEO_NOT_READY`).
  - **Convenção de nome:** o plano cita as exceções em forma curta (`VideoNotFound`), mas segui o sufixo `...Exception` da fase-02 (`EmailAlreadyExistsException`, etc.) → classes nomeadas `VideoNotFoundException`, `ForbiddenNotOwnerException`, … (mesma identidade semântica; consistência com o código existente).
  - `VideoOwnerGuard` resolve o vídeo por `public_id` com `relations: { channel: true }` e compara `video.channel.user_id` a `request.user.sub` (o `JwtPayload` da fase-02 usa `sub` como id do usuário, populado pelo `JwtAuthGuard` herdado). Lança `VideoNotFoundException` (existência oculta) antes de `ForbiddenNotOwnerException`.
  - O guard consulta o repositório diretamente (design do plano), então tem lógica interna própria → o teste unitário com repo mockado é apropriado (a recomendação genérica do testing-guide de delegar a um service e testar via E2E não se aplica ao design deste SI). A cobertura E2E do guard vem quando ele for acoplado ao controller (SI-03.7).
  - Ainda sem `VideosModule`/`TypeOrmModule.forFeature([Video])` (fora do escopo do SI-03.5); o guard é injetável mas só será registrado num módulo em SIs posteriores.

### SI-03.6 — VideosService: rascunho + orquestração de upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Controller de upload + DTOs (HTTP wiring)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Leitura do vídeo + status SSE
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Streaming e download (delivery)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Video worker: processor + entrypoint
- **Status:** pending
- **Tests:** —
- **Observations:** none
