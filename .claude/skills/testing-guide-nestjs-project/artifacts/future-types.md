> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Future Types

Proactive guidance for NestJS artifact types **not yet present** in the project but likely to be added. Types that already have a dedicated guide are cross-referenced, not duplicated.

> **Already covered elsewhere (do not treat as "future"):**
> - **Queue processors / workers** (`*.processor.ts`, BullMQ `WorkerHost`) → `processors.md`.
> - **Pipes, interceptors, middleware, strategies** → their own `artifacts/*.md` files.
> - **Config validation** (Joi) is **already implemented** — see the "Config Validation" section below, which documents the existing pattern.

---

## Custom Decorators (`*.decorator.ts`) — present, mostly skip

The project already has `@CurrentUser()` and `@Public()` (`src/auth/decorators/`).

- **Parameter decorators** (`@CurrentUser()`): **E2E only** — assert the extracted value reaches the handler by testing an endpoint whose response depends on it. No direct unit test.
- **Composition/metadata decorators** (`@Public()` = `SetMetadata`): **Skip** — declarative wrappers; test the behavior they enable (route becomes public) via E2E on the guard.
- Most are thin wrappers around `createParamDecorator()` / `applyDecorators()` with no testable logic.

---

## Config Validation (Joi) — ALREADY PRESENT

`src/config/env.validation.ts` validates env with Joi, and `registerAs` factories (`app/auth/database/mail.config.ts`) namespace config. Covered by `src/config/env.validation.integration-spec.ts`.

**What to test:**
- The schema **rejects** missing/invalid required vars (app would fail to boot).
- The schema **accepts** a valid env and applies defaults/coercion.

```typescript
it('rejects a missing JWT_SECRET', () => {
  const { error } = envValidationSchema.validate({ ...validEnv, JWT_SECRET: undefined });
  expect(error).toBeDefined();
});
```

When adding Phase 03 vars (storage endpoint/bucket/credentials, Redis host/port), extend the Joi schema **and** its spec with a reject-case per new required var.

---

## Event Listeners / Handlers (`@nestjs/event-emitter`) — not yet present

If internal events are adopted (e.g., "video processed" → notify):

- **Handlers with business logic:** Unit (mock deps) + Integration (real DB/external systems).
- **Handlers with only side effects:** Integration (real systems).
- Test the handler method **directly** (call it) — emission is framework behavior; the handler's logic is your code.

---

## Scheduled Tasks / Cron (`@nestjs/schedule`) — not yet present

- Test the scheduled **method** as a regular service method (Unit and/or Integration).
- Do NOT test that the cron schedule fires — trust `@nestjs/schedule`.
- Plausible Phase 03+ use: reaping stale `draft`/`failed` uploads and aborting their multipart uploads.

---

## Health Checks (`@nestjs/terminus`) — not yet present

- **E2E:** `/health` returns 200 when dependencies are up, 503 when one is down.
- With Phase 03, a health check would probe Postgres, Redis, and MinIO reachability.

---

## Strategies (Passport) — unlikely for this project

The project deliberately uses **custom JWT guards**, not Passport strategies (per `phase-02-auth/TD-02` divergence). If a Passport strategy is ever added, see `strategies.md` (test via the guard at the E2E layer).
