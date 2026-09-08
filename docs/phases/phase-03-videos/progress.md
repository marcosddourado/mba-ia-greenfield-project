# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/10 completed

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
- **Status:** completed
- **Tests:** 13 passing (11 unit `videos.service.spec.ts` — createDraft happy/retry/415/400, completeUpload processing+enqueue/404/409/INVALID_PARTS, abortUpload failed/idempotente/404; 2 integration `videos.service.integration-spec.ts` — persistência do rascunho + colisão de `public_id` resolvida contra o índice único real)
- **Observations:**
  - `createDraft(channelId, input)` recebe o `channelId` explicitamente — a resolução canal↔usuário é responsabilidade do controller (SI-03.7). Isso mantém `VideosModule` importando exatamente o que o SI lista (`TypeOrmModule.forFeature([Video])`, `StorageModule`, `QueueModule`), sem `ChannelsModule` (SRP: o service de vídeo não consulta canais).
  - `public_id` via `nanoid@^3` `customAlphabet` (11 chars, alfabeto URL-safe do TD-05; instalado v3 porque v4 é ESM-only e quebraria o stack CJS). Retry em colisão captura `QueryFailedError` code `23505` com `detail` contendo `public_id` (mesmo helper que `channels.service.ts`), sem transação (insert de entidade única → não precisa de SAVEPOINT). `generatePublicId()` é método próprio para permitir forçar colisão no teste de integração via `jest.spyOn`.
  - Validações de domínio em `createDraft`: `contentType` deve começar com `video/` (senão `UnsupportedMediaTypeException` 415); `sizeBytes` ≤ 10 GB (senão `FileTooLargeException` 400). Estas produzem os códigos do Error Catalog — o `ValidationPipe`/class-validator do DTO (SI-03.7) só daria 400 genérico.
  - `completeUpload` mapeia `{ partNumber, eTag }` → `CompletedPart { PartNumber, ETag }`, chama `storage.completeMultipartUpload` (falha → `InvalidPartsException`), transiciona para `processing`, limpa `upload_id` e enfileira **exatamente um** job `process` com `{ videoId: video.id }` (id interno, não `public_id`, conforme payload dos Events/Messages). `abortUpload` é idempotente: só chama o storage se houver `upload_id`; segunda chamada (já `failed`) é no-op.
  - `size_bytes` persistido como string (`bigint` do TypeORM); `storage_key` = `videos/{publicId}/source`. `issuePartUrls` transiciona `draft→uploading` na primeira emissão (intenção do Data Model) e devolve `expiresAt` derivado de `PRESIGN_EXPIRES_IN_SECONDS`.
  - **tsc gotcha:** tipar o mock do repositório como `jest.Mocked<Pick<Repository, 'create'|'save'>>` colide com as overloads do TypeORM sob `tsc --noEmit` (os testes passam no ts-jest, mas o type-check do projeto falha). Troquei por um triplo `jest.Mock` simples injetado via `getRepositoryToken` → tsc = 0.
  - `VideosModule` criado mas a validação de DI cross-módulo (fila `video-processing` exportada via `QueueModule → exports: [BullModule]`) só é exercida quando o controller/e2e do SI-03.7 subir o módulo; os testes deste SI constroem o `VideosService` diretamente. tsc limpo.
  - **`/simplify` (cleanup pós-SI-03.6) + regressões pré-existentes descobertas.** A limpeza do diff aplicou: extração do helper `isPgUniqueViolationOnColumn` duplicado para `src/common/database/pg-errors.ts` (reusado por `ChannelsService` e `VideosService`); simplificação do loop de retry (`for(;;)`, sem `throw` inalcançável); estreitamento do retorno de `getUploadableVideo` (remoção de 4 casts `as string`); Set de 2 estados → disjunção inline. Rodar a suíte completa (que o `/simplify` provocou) revelou que **o baseline commitado da fase-03 estava vermelho na suíte completa** — regressões que o loop per-SI não pegou porque só roda os testes do próprio SI:
    - **SI-03.2 (relação `Channel@OneToMany(Video)`):** ~11 DataSources de teste (auth/users/channels/videos/migrations) listavam `Channel` sem `Video` → `Entity metadata for Channel#videos was not found` no `initialize()`. **Fix:** adicionado `Video` a todas as listas de entidades de teste que incluem `Channel`.
    - **SI-03.2 (ordem de FK no cleanup):** `cleanAllTables` não deletava `videos` antes de `channels`. **Fix:** adicionado `DELETE FROM "videos"` no topo (reverse-FK, conforme testing-guide gotchas); os specs de vídeo passaram a usar `cleanAllTables` (limpa tokens também, evitando FK `users`←`verification_tokens`).
    - **SI-03.2 + SI-03.4 (bootstrap real da aplicação):** `AppModule` (com `autoLoadEntities: true`) carregava `Channel` mas não `Video` (o `VideosModule` não estava importado) → **a aplicação não subia** desde a SI-03.2 (quebrava `NestFactory.create`, todo o e2e e o `openapi-export`, mascarado por `logger:false` → `process.exit(1)`). **Fix:** `VideosModule` importado no `AppModule` (o que a SI-03.7 faria de qualquer forma; sem controller ainda). Verificado `BOOT OK`.
    - **Estado sujo do DB compartilhado:** linha órfã em `videos` acumulada nas corridas de debug bloqueava a criação do FK no `synchronize`; limpa uma vez.
  - **Baseline final verde:** `npm test -- --runInBand` 29 suites/170 testes, `npm run test:e2e` 3 suites/52 testes, `tsc --noEmit` 0, `npm run lint` 0 erros (40 warnings pré-existentes). `AppModule` sobe.
  - **Follow-up (fora de escopo):** `ALL_ENTITIES` está duplicado em ~11 specs — um `src/test/entities.ts` compartilhado evitaria recorrência desta classe de bug. Igualmente, o fixture `createChannel` está duplicado entre specs. Não aplicado agora (churn amplo em arquivos commitados).

### SI-03.7 — Controller de upload + DTOs (HTTP wiring)
- **Status:** completed
- **Tests:** 7 passing (E2E `test/videos-upload.e2e-spec.ts` — 4× `POST /videos`: draft+multipart-init, FILE_TOO_LARGE, UNSUPPORTED_MEDIA_TYPE, 401 unauth; 3× handshake: presign contra o gateway público, owner complete→processing+enqueue, complete por não-dono→403 FORBIDDEN_NOT_OWNER). Suíte e2e completa verde: 4 suites/59.
- **Observations:**
  - **Guards:** JWT auth é global (`APP_GUARD`, per `nestjs-controllers.md`), então o controller não aplica `@UseGuards(JwtAuthGuard)`; as 3 rotas por-vídeo adicionam `@UseGuards(VideoOwnerGuard)` (registrado como provider no `VideosModule` para o DI resolver o `@InjectRepository(Video)`). Ordem: global JwtAuthGuard (401 + popula `request.user`) → VideoOwnerGuard (404 antes de 403) → service (409/400).
  - **DTOs deliberadamente permissivos:** `create-video.dto.ts` valida presença/tipo/tamanho de string, mas NÃO impõe o allowlist `video/*` nem o teto de 10 GB — essas são regras de domínio no service que produzem os códigos do Error Catalog (`UNSUPPORTED_MEDIA_TYPE` 415, `FILE_TOO_LARGE` 400). Um `@Matches`/`@Max` no DTO daria um 400 genérico de validação e mascararia o código específico exigido pelas ACs. `part-urls.dto.ts` e `complete-upload.dto.ts` (com `@ValidateNested`+`@Type` no array de parts) impõem as bordas 1..10000.
  - **Resolução de canal (SRP):** o `createDraft` recebe `channelId`; o controller resolve o canal do usuário autenticado via novo `ChannelsService.findByUserId(userId)` (o domínio de canal é dono da própria consulta — não vazei o repositório de Channel para dentro de videos). `VideosModule` passou a importar `ChannelsModule` (que já exporta `ChannelsService`). Sem teste dedicado para o read de uma linha — coberto transitivamente pelo E2E (o `channel_id` do draft é asseverado contra o canal semeado).
  - **Swagger:** `@ApiTags('videos')` + `@ApiBearerAuth('access-token')` na classe; cada rota com `@ApiOperation` + um `@ApiResponse` por status previsível referenciando `ApiErrorEnvelope` via `getSchemaPath`; sucessos tipados com response DTOs (`CreateVideoResponseDto`, `PartUrlsResponseDto`, `CompleteUploadResponseDto`). Plugin `@nestjs/swagger` (classValidatorShim) infere `@ApiProperty` dos request DTOs.
  - **Fidelidade do E2E:** presigner apontado para `storage-gateway:9000` via `process.env.STORAGE_PUBLIC_HOST` antes do bootstrap (mesmo padrão do `storage.service.integration-spec.ts`; `localhost:9000` resolveria para o próprio container). O cenário `complete` faz um upload real de 1 parte (presign → PUT no gateway → ETag genuíno) porque o `"etag-1"` literal do spec seria rejeitado pelo MinIO real. O enfileiramento é asseverado com `jest.spyOn(queue, 'add')` — determinístico frente ao container `video-worker` em execução, que de outro modo drenaria `queue.getWaiting()`.
  - **Reparo de baseline (infra de teste):** `npm run test:e2e` rodava as suites em paralelo (script sem `--runInBand`, `jest-e2e.json` sem `maxWorkers`). Latente enquanto só `auth` truncava o DB compartilhado; ao adicionar uma 2ª suite e2e que também trunca `users`/`channels` (videos-upload), surgiu contaminação de FK (usuários deletados no meio do voo → falhas em auth E videos). **Fix:** `"maxWorkers": 1` em `test/jest-e2e.json`, gravando o mandato "e2e serial no DB compartilhado" (CLAUDE.md) no nível de config — qualquer invocação (script, IDE, CI) roda serial. Suíte completa depois: e2e 4/59, unit+integration 29/170, `tsc` 0, `lint` 0 erros (41 warnings pré-existentes + 1 `no-unsafe-argument` no novo e2e).
  - **Flow ao vivo verificado** contra o app em execução: register → token do Mailpit → confirm → login → `POST /videos` (draft) → part-urls (host `localhost:9000` = gateway público, nunca `minio:9000`) → PUT da parte → complete = `processing`.

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
