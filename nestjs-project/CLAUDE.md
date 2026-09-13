# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, storage, queue, worker) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps -a   # every service "running", except the one-shot `createbuckets` → "exited (0)"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO (through the gateway):** `curl -s -o /dev/null -w '%{http_code}' http://localhost:9000/minio/health/live` — expect `200`
- **Video worker:** `docker compose logs video-worker` — expect `Video-processing worker started`. If `video-worker` exited (e.g. it started before `npm install`), run `docker compose up -d video-worker`.

The `video-worker` container is part of the environment (it starts with `docker compose up -d`). Only start the NestJS **API** dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Apply migrations (first time, and after pulling new migrations)
docker compose exec nestjs-api npm run migration:run

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

`ffmpeg`/`ffprobe` are baked into `Dockerfile.dev` (shared by `nestjs-api` and `video-worker`). Images built before Phase 03 lack them — rebuild with `docker compose build`.

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, web UI `8025`
- `minio` — S3-compatible object storage. Its API port `9000` is **not** published to the host; web console on `9001`
- `createbuckets` — one-shot `minio/mc` job that creates the `STORAGE_BUCKET`, then exits
- `storage-gateway` — Caddy reverse proxy (`gateway/Caddyfile`), port `9000`; the only host/browser-facing door to MinIO
- `redis` — Redis 7 for BullMQ, port `6379`
- `video-worker` — dedicated video-processing worker (`npm run start:worker:dev`, entrypoint `src/main.worker.ts`), no HTTP port

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify Redis and MinIO (through the gateway) are ready
docker compose exec redis redis-cli ping
curl -s -o /dev/null -w '%{http_code}' http://localhost:9000/minio/health/live

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run compiled video worker (dist/main.worker)
npm run migration:run                    # Apply TypeORM migrations
npm run migration:generate -- src/database/migrations/<Name>   # Generate a migration from entity changes

npm test                                 # Unit + integration tests (serial)
npm run test:watch                       # Unit + integration tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (serial)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single database (plus Redis and MinIO), so suites must run serially. Both Jest configs enforce it with `"maxWorkers": 1` (`package.json` → `jest`, and `test/jest-e2e.json`) — no `--runInBand` flag needed:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Never remove `maxWorkers: 1` from either config: parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entrypoints share `src/`: `src/main.ts` (HTTP API, `AppModule`) and `src/main.worker.ts` (video worker, `WorkerModule`, no HTTP server)

## Videos Module (Phase 03)

Upload, processing, and delivery of videos up to 10 GB. The API **never receives or proxies video bytes** — it only brokers presigned URLs. Contracts, authorization matrix, and error catalog: `docs/phases/phase-03-videos/phase-03-videos.md`.

### Layout

- `src/videos/` — `VideosController`, `VideosService` (draft, upload handshake, visibility, delivery URLs, SSE status), `VideoOwnerGuard`, DTOs, domain exceptions (`exceptions/video.exceptions.ts`), `Video` entity (many-to-one `Channel`), storage key scheme (`video-storage-keys.ts` → `videos/<publicId>/source`, `videos/<publicId>/thumbnail.jpg`)
- `src/videos/processors/video-processing.processor.ts` + `src/videos/worker.module.ts` — the FFmpeg worker (`ffprobe` metadata/duration + `ffmpeg` thumbnail, via `execa`)
- `src/storage/` — `StorageService`, the S3 SDK adapter (multipart, presign, download, put)
- `src/queue/` — `QueueModule` (BullMQ Redis connection + `video-processing` queue; name in `queue.constants.ts`)
- Config: `storage.config.ts` (`STORAGE_*`) and `queue.config.ts` (`REDIS_*`), validated in `env.validation.ts`
- Migration: `src/database/migrations/1788745243630-CreateVideos.ts`

### Endpoints

| Endpoint | Access | Effect |
|---|---|---|
| `POST /videos` | authenticated | Creates `draft` + opens multipart upload |
| `POST /videos/:publicId/upload/part-urls` | owner | Presigned `UploadPart` URLs (`draft → uploading`) |
| `POST /videos/:publicId/upload/complete` | owner | Completes multipart, `→ processing`, enqueues job |
| `DELETE /videos/:publicId/upload` | owner | Aborts multipart, `→ failed` (idempotent) |
| `GET /videos/:publicId` | public (`ready` only); owner sees any status | Video DTO |
| `GET /videos/:publicId/status` | owner | SSE `{ status, progress }` |
| `GET /videos/:publicId/stream` · `/download` | public, `ready` only | 302 to presigned gateway URL (Range / attachment) |

### Rules and gotchas

- **No file bytes through the API.** Do not add multipart/`multer` upload endpoints for videos. The 10 GB ceiling (`MAX_FILE_SIZE_BYTES`) and the `video/*` check live in `VideosService`, so they produce `FILE_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE`. The DTOs are intentionally permissive on those two fields.
- **Hidden existence:** a non-`ready` video requested by a non-owner returns `404 VIDEO_NOT_FOUND`, never 403.
- **Consumer only in the worker:** `VideoProcessingProcessor` is registered in `WorkerModule` only — registering it in `VideosModule` would make the API consume jobs. Don't start a second worker inside `nestjs-api` either; the `video-worker` container is the consumer (production image: `Dockerfile.worker`).
- **Job contract:** name `process`, payload `{ videoId }` (internal uuid, not `publicId`). Delivery is at-least-once, so the processor must stay idempotent.
- **`WorkerModule` entities:** `autoLoadEntities` only discovers entities registered via `forFeature`, so the worker registers the whole relation graph `[Video, Channel, User]`. Omitting one fails boot with `Entity metadata for Video#channel was not found`. For the same reason, test `DataSource` entity lists that include `Channel` must include `Video`, and `cleanAllTables` deletes `videos` before `channels`.
- **Two S3 clients:** `StorageService` uses a control-plane client on `STORAGE_ENDPOINT` (`minio:9000`) and a presigner on `STORAGE_PUBLIC_HOST` (the gateway). SigV4 signs the `Host` including the port, so `gateway/Caddyfile` must forward `header_up Host {hostport}` — `{host}` drops the port and every presigned URL fails with `SignatureDoesNotMatch`.
- **Presigned URLs in tests:** inside the container `localhost:9000` is the container itself. Specs that fetch presigned URLs set `process.env.STORAGE_PUBLIC_HOST = 'http://storage-gateway:9000'` before bootstrapping the app.
- **CommonJS pins:** the ts-jest stack is CommonJS, and the next majors of these libraries are ESM-only — keep `nanoid@^3`, `execa@^5`, `@nestjs/bullmq@^11`. Keep `ioredis` as an explicit dependency (optional peer that `bullmq@6` needs at runtime).
- **SSE:** `@Sse` handlers return `Observable<MessageEvent>` with `MessageEvent` from `@nestjs/common`. E2E tests read the stream with `app.listen(0)` + `fetch` (supertest does not handle streaming).

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
