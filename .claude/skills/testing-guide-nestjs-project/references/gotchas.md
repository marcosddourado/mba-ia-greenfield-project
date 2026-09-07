> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Stack-Specific Gotchas & Pitfalls

Concrete traps for this NestJS 11 + TypeORM 0.3 + Jest 30 + ts-jest 29 + BullMQ/MinIO stack. Ordered roughly by how often they bite.

## Jest / lifecycle

### Jest hangs after tests finish — open handles
Two common causes in this project:
1. **Nest app not closed** in E2E → `afterAll(async () => { await app.close(); });`.
2. **BullMQ / `ioredis` connections left open** → `await queue.close()`, `await queueEvents.close()`, and `await moduleRef.close()` (which closes `@Processor` workers) in `afterAll`. `connection.disconnect()` is the reliable last-resort cleanup when a lingering Redis handle remains.

When it still hangs: `npm test -- --runInBand --detectOpenHandles` to find the leak. `--forceExit` is a last resort — fix the leak first.

### `--runInBand` is mandatory for integration + E2E
Integration and E2E share one Postgres and one Redis. Parallel Jest workers truncate/seed shared tables and queues concurrently → FK violations, deadlocks, cross-suite contamination. `test:integration` and `test:e2e` already set `--runInBand`; keep it (and pass it to `npm test` when running integration specs).

### Await async job completion — never `setTimeout`
For processor tests, block on `await job.waitUntilFinished(queueEvents)` or a `completed` listener. `setTimeout`-based waits are flaky and are the documented cause of "Jest did not exit one second after the test run completed" with BullMQ.

## Database (TypeORM + Postgres)

### `repository.delete({})` throws `Empty criteria(s) are not allowed`
Use `dataSource.query('DELETE FROM "table"')`, the `cleanAllTables()` helper, or `repository.clear()` (TRUNCATE). For deep FK chains: `dataSource.query('TRUNCATE "videos", "channels", "users" CASCADE')`.

### Extend `cleanAllTables()` in reverse-FK order for new entities
`videos.channel_id → channels.id`, so `DELETE FROM "videos"` must run **before** `DELETE FROM "channels"`. Add new tables at the top of the delete sequence in `src/test/create-test-data-source.ts`.

### Always quote table names in raw queries
TypeORM keeps identifiers as declared; `DELETE FROM users` can fail depending on casing. Use `dataSource.query('DELETE FROM "users"')`, or derive the name: `dataSource.getRepository(User).metadata.tableName`.

### `bigint` columns come back as strings
TypeORM maps Postgres `bigint` (e.g., `Video.size_bytes`) to a JS `string` to preserve precision. Assert `expect(video.size_bytes).toBe('12884901888')`, or convert before numeric comparison — do not expect a `number`.

### `synchronize: true` creates but does not reset schema
`synchronize: true` (the `createTestDataSource` default) creates missing tables/columns but never drops renamed/removed ones. If you rename a column, the stale one persists. For a clean slate: `await dataSource.synchronize(true)` (drop + recreate — destructive, tests only), or drop the test DB before the suite. To test real migrations instead, use `createTestDataSource(entities, { synchronize: false, migrations: [...] })` (see `src/database/migrations.integration-spec.ts`).

### `forRootAsync` + `ConfigType` needs a GLOBAL ConfigModule
When the module under test (or an import) uses `X.forRootAsync({ inject: [someConfig.KEY], useFactory })`, the test module must include `ConfigModule.forRoot({ isGlobal: true, load: [someConfig] })`. `forRootAsync`'s factory context does not inherit non-global providers → cryptic "Nest can't resolve dependencies of the (?)" errors.

## E2E (supertest)

### `Test.createTestingModule()` does NOT run `main.ts`
Global pipes/filters/interceptors/prefix from `main.ts` are skipped. Re-apply them in `beforeAll`:
```typescript
app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
app.useGlobalFilters(new DomainExceptionFilter(), new ValidationExceptionFilter());
await app.init();
```
Extract the global config into a shared function used by both `main.ts` and E2E setup to keep them in sync.

### Overriding a guard registered with `APP_GUARD` + `useClass`
`overrideProvider(SomeGuard).useValue(...)` does NOT intercept `{ provide: APP_GUARD, useClass: SomeGuard }` — `useClass` instantiates a fresh guard, not your token. Instead: (1) override the **state token** the guard depends on (`@nestjs/throttler`'s `ThrottlerStorage` symbol → `storage.clear()` in `beforeEach`), or (2) register the guard via `useExisting` so `overrideProvider` can target it.

### Supertest import + typing under `nodenext`
Match the existing E2E pattern:
```typescript
import request from 'supertest';
import { App } from 'supertest/types';
let app: INestApplication<App>;
```

## Auth / crypto

### Argon2 is slow by design — lower cost in tests, do NOT mock
The project hashes with **argon2** (argon2id, per `phase-02-auth/TD-01`), not bcrypt. OWASP prod minimums (19 MiB memory, 2 iterations) make each hash slow; a suite that registers many users drags. Use lower `memoryCost`/`timeCost` under `NODE_ENV=test`, but keep the **real** argon2 code path — mocking it would hide a wrong verify/hash config.

## Object storage (MinIO / AWS SDK v3)

### `forcePathStyle: true` is required for MinIO
Without it the SDK builds virtual-host URLs (`bucket.minio:9000`) MinIO does not serve. Set it on every test `S3Client`.

### MinIO `AccessDenied` about "unsigned headers"
SDK v3 signs a specific header set; if the client (`fetch`/browser) sends a header not covered by the signature, MinIO rejects it. Keep `x-amz-*` headers signed (`unhoistableHeaders` on `getSignedUrl`) and don't add unsigned headers to the request. Assert presigned behavior with a **real** HTTP PUT/GET (200 / 206), never a mocked URL string. Sign against a host the test can actually reach (prod signs the public gateway, never `minio:9000`, per `TD-04`).

## Queue (BullMQ)

### Integration = real queue inspection; unit = `add` spy
Integration tests enqueue for real and read `queue.getJobs(['waiting'])`. Reserve `expect(queue.add).toHaveBeenCalledWith(...)` for **unit** tests where the queue is a mock provider (`getQueueToken`). Isolate state with `await queue.obliterate({ force: true })` (or `drain`) in `afterEach`, or a per-suite queue name.

## SSE (`@Sse`)

### `MessageEvent` comes from `@nestjs/common`, not the DOM
Importing the DOM `MessageEvent` compiles but yields the wrong shape. Test an `@Sse` handler by subscribing to the returned `Observable<MessageEvent>` and asserting `data` (`firstValueFrom(obs.pipe(take(1)))`) — supertest does not cleanly consume an infinite stream. Be aware of a known Nest issue where piped SSE messages can arrive out of order under load.

## FFmpeg

### Binaries must be on `PATH`
`execa('ffprobe'|'ffmpeg', ...)` fails if the binaries aren't installed; they live in the worker image (SI-03.10) or a CI step. Guard the suite with `describe.skip` when absent so the failure is explicit, and commit a small fixture video rather than generating one at runtime.

## NestJS DI mocking

### Prefer `useValue` over `jest.mock()`
`jest.mock('./users.service')` replaces the whole module and fights NestJS DI (token mismatch). Use `{ provide: UsersService, useValue: { findByEmail: jest.fn() } }` instead. See `references/mock-health-rules.md`.

### E2E vs unit imports
- **E2E** (`*.e2e-spec.ts`): `imports: [AppModule]` — full app, real HTTP stack.
- **Integration** (`*.integration-spec.ts`): specific `TypeOrmModule.forFeature([Entity])` / `BullModule` + the providers under test.
- **Unit** (`*.spec.ts`): `providers: [Sut, { provide: Dep, useValue: mock }]` — no module imports beyond configured libs.

### ts-jest 29 with Jest 30
ts-jest 29.2.5 is compatible with Jest 30 for the project's `commonjs` output. If transform/ESM edge cases appear, check for a ts-jest 30.x release before working around it.
