> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# File Conventions

## Naming & Placement

| Layer | File Pattern | Location | Matched by |
|---|---|---|---|
| **Unit** | `*.spec.ts` | Colocated with source in `src/` | `package.json` jest `testRegex: .*\.(spec\|integration-spec)\.ts$` |
| **Integration** | `*.integration-spec.ts` | Colocated with source in `src/` | same regex (the `integration-spec` alternative) |
| **E2E** | `*.e2e-spec.ts` | `test/` directory | `test/jest-e2e.json` (`testRegex: .e2e-spec.ts$`) |

> **The integration suffix is `*.integration-spec.ts` (hyphen), not `*.integration.spec.ts`.** The dotted form is NOT matched by the project's `testRegex` and would silently never run. This mirrors `nestjs-project/CLAUDE.md` → "Test Type Selection".

### Examples (real files in the project)

```
src/
  auth/
    auth.service.ts
    auth.service.spec.ts                       # Unit
    auth.service.integration-spec.ts           # Integration
    auth.module.ts
    auth.module.spec.ts                        # Module compilation
    entities/refresh-token.entity.ts
    entities/refresh-token.entity.integration-spec.ts
    guards/jwt-auth.guard.ts
    guards/jwt-auth.guard.spec.ts              # Guard unit
  common/filters/domain-exception.filter.spec.ts
  config/env.validation.integration-spec.ts
  database/migrations.integration-spec.ts
test/
  auth.e2e-spec.ts
  app.e2e-spec.ts
  jest-e2e.json
```

Shared test helpers live in `src/test/`:
- `create-test-data-source.ts` — `createTestDataSource(entities, opts)` + `cleanAllTables(dataSource)`.
- `mailpit.ts` — `getMailpitMessages()`, `getMailpitMessage(id)`, `clearMailpitMessages()`.

## Running tests

Every test command runs **inside the container** (`nestjs-project/CLAUDE.md` — host runs cause env-var/Node divergence):

```bash
# Unit + integration (all *.spec.ts / *.integration-spec.ts in src/) — serialize shared DB/Redis
docker compose exec nestjs-api npm test -- --runInBand

# Integration only
docker compose exec nestjs-api npm run test:integration

# E2E (test/jest-e2e.json)
docker compose exec nestjs-api npm run test:e2e

# One file
docker compose exec nestjs-api npm test -- --runInBand src/auth/auth.service.spec.ts

# Find leaking open handles when Jest hangs
docker compose exec nestjs-api npm test -- --runInBand --detectOpenHandles
```

Integration + E2E **must** use `--runInBand` — they share one Postgres and one Redis; parallel runs corrupt shared state (`test:integration` and `test:e2e` already set it).

## Coverage philosophy — Pragmatic

The team follows a **pragmatic** philosophy: **test what matters** — business-critical paths and system boundaries — and skip trivial or low-risk code. There are **no hard global coverage-percentage gates**; a green suite is judged by whether the §2 "Worth testing" criteria (in `../SKILL.md`) are covered, not by a number.

Concretely:
- **Cover:** service branching, entity constraints, DB/storage/queue contracts, guard authorization, filter error mapping, controller HTTP contracts (status/validation/auth), security boundaries, race conditions (`public_id` collision, job idempotency).
- **Skip:** trivial getters (`getHello`), framework passthrough, mirror tests, static field existence, validation-decorator internals.
- Use `npm run test:cov` as a **gap-finding tool** (spot an untested branch), not as a bar to clear.

## Jest configuration (authoritative — from `package.json`)

```json
{
  "jest": {
    "moduleFileExtensions": ["js", "json", "ts"],
    "rootDir": "src",
    "testRegex": ".*\\.(spec|integration-spec)\\.ts$",
    "transform": { "^.+\\.(t|j)s$": "ts-jest" },
    "collectCoverageFrom": ["**/*.(t|j)s"],
    "coverageDirectory": "../coverage",
    "testEnvironment": "node",
    "setupFiles": ["dotenv/config"]
  }
}
```

`setupFiles: ["dotenv/config"]` is load-bearing — without it `.env` is not loaded into the Jest process and `DB_HOST`/`JWT_SECRET`/`MAIL_HOST` fall back to `localhost`/undefined, breaking container-to-container DNS.

**E2E** (`test/jest-e2e.json`): `rootDir: "."`, `testRegex: ".e2e-spec.ts$"`, ts-jest transform, `setupFiles: ["dotenv/config"]`.

## Test structure

Follow Arrange-Act-Assert:
```typescript
it('rejects an unknown user', async () => {
  usersService.findByEmail.mockResolvedValue(null);           // Arrange
  await expect(authService.login('no@user.com', 'pass'))       // Act + Assert
    .rejects.toThrow(/* domain exception */);
});
```
- `describe('AuthService')` → `describe('login')` → `it('should …')`.
- Name tests with the observable behavior, not the implementation.
- `beforeAll`/`afterAll` for expensive setup (app, DataSource); `beforeEach`/`afterEach` for per-test state (table/queue/Mailpit cleanup).
