---
name: testing-guide-nestjs-project
description: >
  Testing guide for nestjs-project. Reference this skill when planning features,
  implementing code, creating tests, or reviewing changes in nestjs-project.
  Covers what to test, at which layer, and how to set up each test —
  organized by artifact type.
  Triggers on: planning nestjs-project features, implementing nestjs-project features,
  writing tests for nestjs-project, reviewing nestjs-project code, reviewing nestjs-project tests,
  what should I test in nestjs-project, how to test nestjs-project, nestjs-project test guide.
---

## 0. Purpose

This guide helps you decide **what to test**, at **which layer**, and **how to set up tests** for each type of artifact in `nestjs-project`. When working on a specific artifact type, read the corresponding guide in `artifacts/` for the complete recipe. Supporting references (mock strategies, file conventions, gotchas) are in `references/`.

Artifact types covered: entities, services, modules, controllers, DTOs, guards, filters, processors (queue workers), pipes, interceptors, middleware, strategies. For anticipated types not yet in the project, see `artifacts/future-types.md`.

> This guide is a **reference document**. Pre-creation decisions (which suffix, where the file lives) are in `nestjs-project/CLAUDE.md` → "Test Type Selection"; how-to-write conventions are in `.claude/rules/nestjs-testing.md`. This skill decides *what* and *at which layer*; those two decide *where* and *how*.

## 1. Testability Foundations

NestJS's DI container makes testing natural — `Test.createTestingModule()` lets you replace any provider with a mock via `useValue`, `useFactory`, or `useClass`, and `overrideProvider(X).useValue(...)` swaps a provider without touching module imports. This is why unit tests mock at **service boundaries** rather than patching internal methods.

**Why module compilation tests matter:** TypeScript catches type errors at compile time, but NestJS resolves dependencies at *runtime* via the DI container. A missing `imports` entry, a wrong provider token, or a forgotten `exports` array causes a runtime crash TypeScript cannot catch. `Test.createTestingModule({ imports: [MyModule] }).compile()` is the only way to catch DI wiring errors before production. This project registers config with `registerAs` + `forRootAsync` — those factories only resolve when a **global** `ConfigModule` is present in the test module (see `references/gotchas.md`).

**Mock boundary principle in NestJS terms:** Mock across module boundaries, not within. If `AuthService` depends on `UsersService`, mock `UsersService` in `AuthService`'s unit test — `UsersService` has its own tests. But use *real* `JwtModule` with test config because it's a configured library — mocking `JwtService.sign()` returning `'fake-token'` never catches a wrong secret, bad expiration, or malformed payload. Likewise, mock the **BullMQ `Queue`** in a producer's unit test (enqueuing is a side effect at a boundary), but use a **real Redis-backed queue** in the producer's integration test and a **real worker** in the processor's integration test.

**Why integration tests aren't redundant with E2E:** E2E proves the HTTP contract (status codes, validation wiring, response shape). Integration proves the *external-system contract* (correct queries, constraint enforcement, presigned-URL validity, job actually enqueued/processed). A service that builds a wrong `WHERE` clause, generates a URL against the wrong host, or forgets to enqueue passes E2E with mocked collaborators but fails in production. Both layers are required; neither substitutes the other.

**Configured dependency contracts:** When you configure a framework module (`JwtModule.register()`, `ThrottlerModule.forRoot()`, `BullModule.forRoot()`, `TypeOrmModule.forRootAsync()`), that configuration is a contract. The library's tests verify its internals — they cannot verify YOUR config values. Test configured libs with real instances and test-appropriate config.

**NestJS 11 + Jest 30 + ts-jest 29:** The project runs NestJS 11.0.1 with Jest 30 and ts-jest 29.2.5, TypeORM 0.3.28, `@nestjs/testing` 11. `Test.createTestingModule()` provides full DI; `overrideProvider()` is the idiomatic provider swap. Integration and E2E suites share one Postgres and MUST run with `--runInBand` (parallel runs corrupt shared tables). Redis-backed workers and `ioredis` connections leave open handles — always `await worker.close()` / `queue.close()` in `afterAll`, and reach for `--detectOpenHandles` when Jest hangs (see `references/gotchas.md`).

## 2. Testing Criteria

### Worth testing

- Services with branching logic (registration flow, login, password reset, video status transitions, ownership/visibility rules)
- Entity constraints and defaults — unique indexes (`public_id`), `select: false` fields, `@CreateDateColumn`/default enums (`status='draft'`), FK relations, `bigint` columns
- Service-to-database contracts — repository queries, TypeORM relation loading, transaction boundaries, compensation/rollback paths
- Service-to-external-system contracts — S3/MinIO multipart + presigned URLs, BullMQ job enqueue, worker FFmpeg processing, SMTP sends via Mailpit
- Module DI wiring — every module with configured imports (`TypeOrmModule.forFeature()`, `JwtModule.register()`, `BullModule.registerQueue()`, `forRootAsync`)
- Guard authorization logic — ownership verification, token validation flows
- Exception filter error mapping — domain exceptions → the `{ statusCode, error, message }` HTTP envelope
- Controller HTTP contracts — status codes, validation rejection, auth enforcement, response shape, 302 redirects, SSE stream shape
- DTO validation wiring — one E2E test per endpoint proving `ValidationPipe` is active
- Security boundaries — JWT auth, rate limiting, anonymous-vs-owner access, hidden-existence 404s
- Race conditions — `public_id` collision retry, concurrent uploads, at-least-once job idempotency

### NOT worth testing

- Controllers in isolation (unit tests) — thin delegation; test via E2E only
- Validation decorator behavior (does `@IsEmail()` reject bad email?) — trust `class-validator`; one wiring test per endpoint
- Framework routing / persistence mechanics — trust `@Get()`/`@Post()` and `repository.save()`; test YOUR queries and constraints
- Mirror tests — assertions that copy the implementation's return value
- Static entity field existence — if a column exists, TypeORM maps it
- Single-path service methods with no branching and no system boundary (e.g., `getHello()`)
- Pure delegation to a framework feature with no custom logic
- Route/param decorators (`@CurrentUser()`, `@Public()`) — framework passthrough

## 3. Feature Implementation Checklist

When implementing a new feature, use this checklist to ensure all artifacts have appropriate test coverage:

| Artifact created | Required tests | Guide |
|---|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false`, FK | `artifacts/entities.md` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract | `artifacts/services.md` |
| Service with DB only (no branching) | Integration: DB contract | `artifacts/services.md` |
| Service with configured lib (JWT) | Unit: real lib with test config | `artifacts/services.md` |
| Service with side-effect dep (email/storage/queue) | Integration: real capture (Mailpit) or real adapter (MinIO/Redis) | `artifacts/services.md` |
| Module with configured imports | Unit: compilation test | `artifacts/modules.md` |
| Controller (incl. SSE / 302) | E2E only — do NOT write unit tests | `artifacts/controllers.md` |
| DTO | E2E: one validation wiring test per endpoint | `artifacts/dtos.md` |
| Guard (custom business logic) | Unit + E2E | `artifacts/guards.md` |
| Exception Filter | Unit + E2E | `artifacts/filters.md` |
| Processor / queue worker (`*.processor.ts`) | Integration: real Redis + real worker (+ FFmpeg for video) | `artifacts/processors.md` |
| Pipe (custom transform/validation) | Unit | `artifacts/pipes.md` |
| Interceptor | Unit and/or E2E | `artifacts/interceptors.md` |
| Middleware | E2E | `artifacts/middleware.md` |

**How to use:** After implementing a feature, walk through each row. For each artifact you created or modified, read the corresponding guide and verify the tests exist. Skip rows that don't apply.

## 4. Artifact Type Testing Guide

When creating or modifying an artifact, read the corresponding guide for the complete recipe.

| Artifact Type | Pattern | Test Layer(s) | Guide |
|---|---|---|---|
| Entities | `*.entity.ts` | Integration (real DB) | `artifacts/entities.md` |
| Services | `*.service.ts` | Unit and/or Integration | `artifacts/services.md` |
| Modules | `*.module.ts` | Unit (compilation) | `artifacts/modules.md` |
| Controllers | `*.controller.ts` | E2E only | `artifacts/controllers.md` |
| DTOs | `*.dto.ts` | E2E (validation wiring) | `artifacts/dtos.md` |
| Guards | `*.guard.ts` | Unit + E2E | `artifacts/guards.md` |
| Filters | `*.filter.ts` | Unit + E2E | `artifacts/filters.md` |
| Processors | `*.processor.ts` | Integration (real Redis + worker) | `artifacts/processors.md` |
| Pipes | `*.pipe.ts` | Unit | `artifacts/pipes.md` |
| Interceptors | `*.interceptor.ts` | Unit and/or E2E | `artifacts/interceptors.md` |
| Middleware | `*.middleware.ts` | E2E | `artifacts/middleware.md` |
| Strategies | `*.strategy.ts` | E2E (via guard) | `artifacts/strategies.md` |
| Future types | — | — | `artifacts/future-types.md` |

## 5. Anti-patterns — Do NOT Do This

- ❌ **Unit test controllers** — thin delegation; test via E2E only (see `artifacts/controllers.md`)
- ❌ **Mock configured libs** (JwtService, ThrottlerGuard) — use real instances with test config; mocking hides config bugs (§1)
- ❌ **Skip integration tests for services with DB access** — unit tests with mocked repos don't prove queries are correct (see `artifacts/services.md`)
- ❌ **Skip module compilation tests** — TypeScript can't catch DI wiring errors; a missing import only fails at runtime (see `artifacts/modules.md`)
- ❌ **Use `repository.delete({})` for cleanup** — throws `Empty criteria`; use `dataSource.query('DELETE FROM …')` in FK order or `cleanAllTables()` (see `references/gotchas.md`)
- ❌ **Mock the S3/MinIO client to "test" presigned URLs** — a mocked URL proves nothing; do a real HTTP PUT/GET against the generated URL and assert 200/206 (see `references/external-systems.md`)
- ❌ **Assert a job was enqueued by spying on `queue.add` in an integration test** — use a real Redis queue and inspect `queue.getJobs(['waiting'])`; reserve the `queue.add` spy for *unit* tests (see `artifacts/processors.md`)
- ❌ **Forget to `await worker.close()` / `queue.close()` in `afterAll`** — leaves open Redis handles and Jest hangs (see `references/gotchas.md`)
- ❌ **Forget `afterAll(() => app.close())`** — causes Jest to hang on open handles (see `references/gotchas.md`)
- ❌ **Import DOM `MessageEvent` for `@Sse`** — it comes from `@nestjs/common`; test by subscribing to the returned `Observable` (see `artifacts/controllers.md`)
- ❌ **Skip reproducing `main.ts` global config in E2E** — `Test.createTestingModule()` does NOT run `main.ts`; apply global pipes/filters explicitly (see `references/gotchas.md`)
- ❌ **Throw NestJS HTTP exceptions from services** — services throw domain exceptions; filters map them to HTTP (see `artifacts/filters.md`)
- ❌ **Write mirror tests** — assertions that copy the implementation's return value prove nothing (§2)

## 6. E2E Terminology Note

This guide uses "E2E" to mean **HTTP-layer integration tests** — supertest exercising the full request-to-response chain (routing → guards → pipes → controller → service → response). This is NOT browser-based or multi-service end-to-end testing. Industry sources may call these "API integration tests" or "HTTP integration tests."

## 7. References

| Topic | File |
|---|---|
| External system strategies (Postgres, MinIO/S3, Redis/BullMQ, FFmpeg, Mailpit) | `references/external-systems.md` |
| Mock health rules & boundary principle | `references/mock-health-rules.md` |
| File naming, directory structure, coverage philosophy | `references/file-conventions.md` |
| Stack-specific gotchas & pitfalls | `references/gotchas.md` |

## 8. How to Use This Guide

This guide is organized as a multi-file skill:
- **This file (SKILL.md)** — always loaded. Core rules, quick reference, anti-patterns.
- **`artifacts/`** — one file per artifact type. Read the relevant file when creating or modifying that type.
- **`references/`** — supporting content. Read when you need mock strategies, conventions, or gotchas.

When working on a feature:
1. Check §3 (Feature Implementation Checklist) to identify which artifacts need tests
2. Read the corresponding `artifacts/*.md` file for the complete testing recipe
3. Consult `references/` files as needed for mock strategies, conventions, or pitfalls
