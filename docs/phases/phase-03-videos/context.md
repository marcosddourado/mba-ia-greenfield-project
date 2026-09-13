---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-30T12:40:01-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-06T18:15:08-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-06T11:41:23-0300"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-06T11:41:23-0300"
  docs/phases/phase-02-auth/context.md: "2026-09-06T11:41:23-0300"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-06T11:41:23-0300"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-30T12:40:01-0300"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in `docs/project-plan.md`._ (The decisions doc adds one scope boundary carried by the TDs: no adaptive-bitrate/HLS/DASH transcoding — progressive HTTP Range streaming only; see `phase-03-videos/TD-06` and `phase-03-videos/TD-08`.)

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project` — primary/affected (storage service, queue producer + video worker/FFmpeg, `Video` entity + migration, upload orchestration + presigned-URL issuance, processing-status exposure, streaming/download endpoints).

**Deferred subprojects:** `next-frontend` — consumes the Cross-layer contracts settled here (upload handshake, public video URL shape, processing-status polling, streaming/download URLs) but has no Frontend-only TD in this slice; screen composition (upload page UI, progress) is deferred to a future `phase-03-videos-frontend` slice (mirrors the `phase-02-auth` → `phase-02-auth-frontend` split).

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 2:** Cadastro, Login e Gerenciamento de Conta — "Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha."
- **Phase 4:** Gerenciamento de Vídeos e Canal — "Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública."

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object Storage Backend & SDK | decided | A — MinIO (S3-compatible), prod flips to S3 | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-02 | phase | Backend | Background-Job / Message-Queue System | decided | A — BullMQ + Redis | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-03 | phase | Backend | Video Worker Process Topology | decided | A — dedicated worker container (FFmpeg) | — |
| phase-03-videos/TD-04 | phase | Cross-layer | Large-File Upload Protocol (10GB, resumable) | decided | A — presigned S3 multipart, masked-gateway variant | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-05 | phase | Cross-layer | Unique Public Video Identifier / Short URL | decided | A — nanoid `public_id` (CJS pin) | nanoid@^3 |
| phase-03-videos/TD-06 | phase | Backend | Video Processing Tooling & Scope (FFmpeg) | decided | B — direct ffmpeg/ffprobe via execa (no wrapper) | execa@^5 |
| phase-03-videos/TD-07 | phase | Cross-layer | Video Lifecycle & Processing-Status Model | decided | B — status enum + SSE (`@Sse()`) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Media Delivery — Streaming & Download | decided | A — presigned GET (Range + attachment) via masked gateway | @aws-sdk/s3-request-presigner |

_(The `Renders in` column is omitted: no TD in scope sets `**Renders in:**` explicitly — all `—`. This is a legacy 7-column table; downstream A2 resolves default-by-inference against the phase `ui_in_scope` flag.)_

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02, phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-04 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-06, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** MinIO in dev via `@aws-sdk/client-s3` (+ `@aws-sdk/s3-request-presigner`) with `forcePathStyle: true`; prod flips the endpoint to AWS S3. This is the only option that gives identical code across environments while keeping the API out of the 10GB data path.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-02

**Recommendation:** BullMQ + Redis. Its `WorkerHost`/progress model maps directly onto the processing-status lifecycle (TD-07), it is the Nest-idiomatic choice, and it matches the documented architecture. Honest trade-off: if avoiding a Redis dependency is a hard requirement, Option B (pg-boss) is the strongest fallback since Postgres is already present — at the cost of NestJS integration polish.
**Libraries:** @nestjs/bullmq, bullmq

### phase-03-videos/TD-03

**Recommendation:** a dedicated worker service. Phase 03 is precisely where the arch diagram's API/Worker split earns its keep: 10GB-scale ffprobe/thumbnail work must not sit in the API's event loop or image. Share the domain code from the same codebase; only the entrypoint and the FFmpeg base image differ.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** presigned S3 multipart. It is the only option that simultaneously satisfies "no API in the data path" and native resume, and it reuses the TD-01 SDK. Budget one implementation task for the browser-reachable endpoint + bucket CORS (the Docker networking nuance). If a turnkey resumable client UX is valued over API-offload purity, Option B (tus) is the fallback.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
**Note:** Refines the stock "browser → storage direct" default per the user's explicit constraint: the browser must never contact the internal storage host (`minio:9000`). Presigned URLs are generated against the public gateway domain, not the internal service host. Requires a reverse-proxy/gateway service fronting storage in Docker Compose + CORS on that public endpoint. Reuses the TD-01 SDK. The **same masked gateway** serves TD-08 media delivery. The app-layer-proxy alternatives (Next.js or NestJS streaming the bytes) were rejected because they would put an app server in the 10GB byte path, conflicting with "upload sem impacto na performance".

### phase-03-videos/TD-05

**Recommendation:** `nanoid` `public_id`, pinned to `nanoid@^3` for CommonJS compatibility. It best matches "curta e única" with the strongest opacity. If adding a CJS-pinned dependency is undesirable, Option B (`sqids`) is a clean, CJS-native fallback — accept its reversibility.
**Libraries:** nanoid@^3

### phase-03-videos/TD-06

**Recommendation:** `fluent-ffmpeg` for its thumbnail/metadata ergonomics, accepting the maintenance caveat (the FFmpeg CLI surface it wraps is stable). If the team prefers zero wrapper risk, Option B (`execa`) is a clean, lean alternative — the flags for duration + single-frame thumbnail are simple. Either way, FFmpeg binaries live in the worker image (TD-03), and the processing scope stays metadata + thumbnail (+ optional faststart), not ABR.
**Libraries:** execa@^5
**Note:** `execa` pinned to `^5` — the last CommonJS-compatible major (v6+ is ESM-only) — consistent with the project's CJS constraint that also drove `nanoid@^3` in TD-05. Node's built-in `child_process` (promisified `spawn`) is the zero-dependency alternative within this option if the team prefers no wrapper at all. Diverged from the recommendation (`fluent-ffmpeg`) at the user's request.

### phase-03-videos/TD-07

**Recommendation:** status enum + polling. It fully satisfies the capability with no new transport and aligns with the BullMQ progress model (TD-02) exposed via the video DTO. Revisit SSE/WebSocket only if a future phase needs live progress bars; for Phase 03, polling a ready/failed flag is sufficient and simplest.
**Libraries:** —
**Note:** NestJS exposes SSE natively via the `@Sse()` decorator returning an RxJS `Observable` (RxJS is already a NestJS dependency) — no new runtime library. The status enum still backs a `GET /videos/:id` DTO field for one-shot/non-streaming reads; SSE pushes live status transitions (BullMQ progress from TD-02 feeds the event stream). Diverged from the recommendation (polling) at the user's request.

### phase-03-videos/TD-08

**Recommendation:** presigned direct-from-storage for both streaming and download. It keeps the API out of the 10GB data path (coherent with TD-01/TD-04), gets Range streaming for free from the storage layer, and covers download via `response-content-disposition`. When Phase 05 introduces public/unlisted rules, gating moves to the presigned-URL-issuing endpoint.
**Libraries:** @aws-sdk/s3-request-presigner
**Note:** Consistent with the TD-04 masked-gateway decision — the browser never contacts the internal storage host; presigned GET URLs target the public gateway endpoint, not `minio:9000`. When Phase 05 introduces public/unlisted rules, gating moves to the presigned-URL-issuing endpoint. Reuses the TD-01 SDK.

## Inherited Decisions Detail

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 02)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: {...} })`. _(from phase 02)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 02)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 02)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 02)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning `autoLoadEntities: true`, `synchronize: false`. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` — artifact type → required test layer(s). Read the per-artifact guide under `.claude/skills/testing-guide-nestjs-project/artifacts/` for the full recipe.)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration (real DB): constraints, defaults, `select: false` |
| Service — branching + DB (`*.service.ts`) | Unit (branch logic, mock repo) + Integration (DB contract) |
| Service — DB only, no branching | Integration (DB contract) |
| Service — configured lib (JWT, cache) | Unit (real lib with test config) |
| Service — side-effect dep (email, **storage**, **queue**) | Integration (real capture service / local adapter, e.g. Mailpit, MinIO, Redis) |
| Module (`*.module.ts`) | Unit (compilation test) |
| Controller (`*.controller.ts`) | E2E only — do NOT write unit tests |
| DTO (`*.dto.ts`) | E2E (one validation-wiring test per endpoint) |
| Guard (`*.guard.ts`) | E2E; + Unit if complex internal logic |
| Strategy (`*.strategy.ts`) | E2E (via guard) |
| Pipe (`*.pipe.ts`) | Unit |
| Interceptor (`*.interceptor.ts`) | Unit and/or E2E |
| Exception Filter (`*.filter.ts`) | Unit + E2E |
| Middleware (`*.middleware.ts`) | E2E |

_Note for Phase 03: the storage service, queue producer, and video worker are "side-effect dep" services → Integration with real local adapters (MinIO / Redis / FFmpeg) rather than mocks, per `references/external-systems.md`. E2E means HTTP-layer integration tests (supertest), not browser/multi-service._

### next-frontend

_Deferred subproject — no Frontend code is authored in this slice; the FE upload-screen composition (and its `testing-guide-next-frontend` layer requirements) is deferred to the future `phase-03-videos-frontend` slice._
