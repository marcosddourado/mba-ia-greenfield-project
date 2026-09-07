> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Controllers (`*.controller.ts`)

## What to test

Controllers are thin delegation layers — receive HTTP, delegate to services, return responses (enforced by `.claude/rules/nestjs-layer-separation.md`). Testing a controller means testing the **HTTP contract**:

- **Status codes** — correct status per operation (200, 201, 204, 302, 400, 401, 403, 404, 409, 415)
- **Validation rejection** — `ValidationPipe` rejects invalid payloads with 400
- **Auth enforcement** — protected routes return 401 without token, 403 for a non-owner
- **Response shape** — body matches the API contract; sensitive fields absent
- **Error responses** — domain exceptions map to `{ statusCode, error, message }` via the exception filter
- **Redirects** — 302 endpoints set the expected `Location` (e.g., video `stream`/`download` → presigned gateway URL)
- **SSE streams** — `@Sse` endpoints emit `text/event-stream` with the expected `data` shape

## Layer assignment

| Scenario | Unit | Integration | E2E |
|---|---|---|---|
| Any controller (incl. `@Sse`, 302) | ❌ Never | — | ✅ Always |

**Why no unit tests:** controllers have no business logic. A unit test that mocks the service and asserts the return value is a mirror test. The CLI-scaffolded `app.controller.spec.ts` is NOT a pattern to copy.

## Setup pattern (E2E)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('VideosController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));   // CRITICAL: reproduce main.ts
    // app.useGlobalFilters(new DomainExceptionFilter(), new ValidationExceptionFilter());
    await app.init();
  });

  afterAll(async () => { await app.close(); });   // prevents Jest hang

  it('POST /videos without token → 401', () =>
    request(app.getHttpServer()).post('/videos').send({}).expect(401));

  it('POST /videos with oversize file → 400 FILE_TOO_LARGE', () =>
    request(app.getHttpServer())
      .post('/videos').set('Authorization', bearer)
      .send({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 20_000_000_000 })
      .expect(400).expect((r) => expect(r.body.error).toBe('FILE_TOO_LARGE')));

  it('GET /videos/:publicId of a non-ready video by a non-owner → 404 (existence hidden)', () =>
    request(app.getHttpServer()).get(`/videos/${draftPublicId}`).expect(404));
});
```

### Testing 302 redirect endpoints

```typescript
it('GET /videos/:publicId/stream of a ready video → 302 to the gateway', () =>
  request(app.getHttpServer())
    .get(`/videos/${readyPublicId}/stream`)
    .expect(302)
    .expect((r) => {
      expect(r.headers.location).toContain(process.env.STORAGE_PUBLIC_HOST!);
      expect(r.headers.location).not.toContain('minio:9000');   // masking rule (TD-04/08)
    }));

it('GET /videos/:publicId/stream of a non-ready video → 409 VIDEO_NOT_READY', () =>
  request(app.getHttpServer()).get(`/videos/${draftPublicId}/stream`).expect(409));
```
Use `.redirects(0)` if your supertest version follows redirects by default, so you can assert the 302 + `Location` instead of the followed response.

### Testing `@Sse` endpoints

supertest cannot cleanly consume an infinite stream. Two workable approaches:
- **Preferred (unit-of-the-observable):** the `@Sse` handler returns an `Observable<MessageEvent>` (`MessageEvent` from `@nestjs/common`, **not** the DOM). Subscribe and assert the first emission:
  ```typescript
  const first = await firstValueFrom(controller.status(publicId).pipe(take(1)));
  expect(first.data).toEqual({ status: 'processing', progress: expect.any(Number) });
  ```
- **HTTP smoke (optional):** hit the endpoint with a raw client, assert `content-type: text/event-stream` and parse the first `data:` line, then destroy the socket.

Auth (401 without token, 403 non-owner) on the SSE route is still asserted via the normal E2E request.

**Key points:**
- Import `AppModule` — no mocking at the E2E layer; real Postgres + Redis (Docker).
- **Reproduce `main.ts` global config** (`ValidationPipe`, filters) — the test bootstrap does not run `main.ts`.
- `beforeAll`/`afterAll` (app creation is expensive); always `app.close()`.
- Seed prerequisite state (an authenticated user/channel, a `ready` vs `draft` video) via the service or raw inserts.

## When to skip

- Never unit-test a controller.
- Skip redundant E2E variants already covered by another test in the same module unless they have distinct behavior.

## Examples from project

- **AuthController** (`/auth`) — covered by `test/auth.e2e-spec.ts` (register/login/confirm/reset flows, 401/400/409).
- **AppController** — CLI scaffold; `app.controller.spec.ts` is a controller unit test (anti-pattern per this guide).
- **VideosController** (Phase 03, SI-03.7/08/09) — E2E for the upload handshake (201/400/415/403/401), read + `@Sse` status (SI-03.8), and 302 `stream`/`download` with `VIDEO_NOT_READY` (SI-03.9). See `docs/phases/phase-03-videos/phase-03-videos.md` → API Contracts.
