> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Services (`*.service.ts`)

## What to test

- **Branch logic** — conditionals, permission/ownership checks, state transitions (e.g., video `draft→processing→ready/failed`), visibility rules
- **Database contracts** — queries return expected results, constraints respected, transactions and compensation/rollback paths work
- **External system contracts** — S3/MinIO multipart + presigned URLs, BullMQ job enqueue, emails via Mailpit
- **Configured lib behavior** — JWT tokens encode correct claims/expiration
- **Error paths** — the service throws the correct **domain exception** for invalid states, missing resources, duplicates (never a raw NestJS HTTP exception — see `filters.md`)

## Layer assignment

Services are the most varied artifact type. The layer depends on the service's characteristics:

| Scenario | Unit | Integration | Why |
|---|---|---|---|
| Branching logic only (no system boundary) | ✅ mock owned services | — | Logic proven in isolation |
| DB access only (no branching) | — | ✅ real DB | No logic to unit-test; the DB contract IS the behavior |
| Branching + DB access | ✅ mock repo (test branches) | ✅ real DB (test queries) | Unit proves logic; integration proves queries — neither substitutes the other |
| Configured lib (JWT) | ✅ real lib with test config | — | Mocking hides config bugs |
| Side-effect: email | — | ✅ Mailpit capture | Real SMTP transport, no delivery |
| Side-effect: storage (S3/MinIO) | ✅ mock storage to test branches | ✅ real MinIO adapter | Unit proves control flow; integration proves the presigned-URL/multipart contract |
| Side-effect: queue producer (BullMQ) | ✅ mock the `Queue` (`getQueueToken`) | ✅ real Redis queue | Unit proves "enqueues on complete"; integration proves the job lands in Redis |
| Pure delegation (no branching, no boundary) | — | — | Skip — no testable behavior |

**Critical rule:** a unit test that mocks a repository/`S3Client`/`Queue` does NOT prove the query, URL, or enqueue is correct. If a service crosses a system boundary, it needs an integration test with the real system — regardless of whether it also has a unit test. (The queue **consumer** side is a processor — see `processors.md`.)

## Setup pattern — Unit test (branching + configured lib + mocked boundaries)

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { JwtModule } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';

describe('VideosService (unit)', () => {
  let service: VideosService;
  const storage = { createMultipartUpload: jest.fn(), presignUploadPart: jest.fn(),
                    completeMultipartUpload: jest.fn(), abortMultipartUpload: jest.fn() };
  const queue = { add: jest.fn() };
  const repo = { save: jest.fn(), findOneBy: jest.fn(), manager: {} };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: StorageService, useValue: storage },      // owned boundary → mock
        { provide: getQueueToken('video-processing'), useValue: queue }, // producer boundary → mock
        { provide: getRepositoryToken(Video), useValue: repo },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('enqueues exactly one processing job on completeUpload', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'v1', status: 'draft', upload_id: 'u1' });
    await service.completeUpload('pub1', [{ partNumber: 1, eTag: 'e' }]);
    expect(queue.add).toHaveBeenCalledWith('process', { videoId: 'v1' });
  });

  it('retries public_id generation on collision, never surfacing the error', async () => {
    repo.save.mockRejectedValueOnce(new QueryFailedError('', [], { code: '23505' } as any))
             .mockResolvedValueOnce({ id: 'v1' });
    await expect(service.createDraft(dto, channelId)).resolves.toBeDefined();
    expect(repo.save).toHaveBeenCalledTimes(2);
  });
});
```

**Key points:**
- Mock **owned services / boundaries** (`StorageService`, the `Queue`, the repo) with `useValue` — each has its own tests.
- Use **real** `JwtModule` with test config when the service signs/verifies tokens — mocking hides config bugs.
- Assert **observable branch outcomes** (job enqueued, retry happened, domain exception thrown), not internal calls.
- Visibility/authorization logic (e.g., `getByPublicId` returning `ready`-only for anonymous) is pure branching → unit test each branch.

## Setup pattern — Integration test (DB contract)

Use the shared helper for a standalone DataSource, or `TypeOrmModule.forRoot()` when exercising the service through Nest DI:

```typescript
import { createTestDataSource, cleanAllTables } from '../test/create-test-data-source';

describe('ChannelsService (integration)', () => {
  let service: ChannelsService;
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel]);
    await dataSource.initialize();
    service = new ChannelsService(dataSource.getRepository(Channel), /* ... */);
  });
  afterEach(() => cleanAllTables(dataSource));
  afterAll(() => dataSource.destroy());

  it('rejects a duplicate nickname', async () => {
    await service.create({ userId: 'u1', name: 'A', nickname: 'dup' });
    await expect(service.create({ userId: 'u2', name: 'B', nickname: 'dup' }))
      .rejects.toThrow(/* domain exception */);
  });
});
```

**Key points:**
- Real PostgreSQL via Docker (`createTestDataSource` defaults to `synchronize: true`).
- Clean with `cleanAllTables()` / `dataSource.query('DELETE …')` — never `repository.delete({})`.
- Test the actual queries/constraints — not mocked return values.
- For storage/queue integration setup, see `references/external-systems.md`.

## When to skip

- Services that only delegate without branching (e.g., a thin `findOneBy` passthrough) — the entity integration test covers it.
- `AppService.getHello()` — no branching, no boundary, trivial return.

## Examples from project

- **AuthService** [branching + configured lib (JWT) + DB] → Unit: login/register/reset branches with mocked `UsersService` + real `JwtModule` (`auth.service.spec.ts`). Integration: token/DB contract (`auth.service.integration-spec.ts`).
- **UsersService** [DB access] → Integration: real Postgres queries (`users.service.integration-spec.ts`).
- **ChannelsService** [DB + branching] → Unit (nickname logic) + Integration (uniqueness/ownership).
- **MailService** [side-effect: SMTP] → Integration via Mailpit (`mail.service.integration-spec.ts`).
- **VideosService** (Phase 03) [DB + storage + queue producer + branching] → Unit: status transitions, visibility rules, `public_id` collision retry, enqueue (mock storage/queue/repo). Integration: real MinIO presigning/multipart + real Redis enqueue + DB draft persistence. The processing **consumer** is `VideoProcessor` — see `processors.md`.
