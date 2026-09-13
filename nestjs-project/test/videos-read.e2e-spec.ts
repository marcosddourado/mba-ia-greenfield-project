import { AddressInfo } from 'net';
import { Server } from 'http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

const GATEWAY_PUBLIC_HOST = 'http://storage-gateway:9000';

interface StatusEvent {
  status: string;
  progress: number | null;
}

/** Reads an SSE stream until it closes (or times out), returning the events. */
async function collectSseUntilClose(
  res: Response,
  timeoutMs = 5000,
): Promise<{ events: StatusEvent[]; closed: boolean }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: StatusEvent[] = [];
  let buffer = '';
  let closed = false;
  const deadline = Date.now() + timeoutMs;

  const drain = () => {
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (dataLine) events.push(JSON.parse(dataLine.slice(5).trim()));
    }
  };

  while (Date.now() < deadline) {
    drain();
    const remaining = deadline - Date.now();
    const timeout = new Promise<'timeout'>((r) =>
      setTimeout(() => r('timeout'), Math.max(0, remaining)),
    );
    const result = await Promise.race([reader.read(), timeout]);
    if (result === 'timeout') break;
    const { done, value } = result as ReadableStreamReadResult<Uint8Array>;
    if (done) {
      closed = true;
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  drain();
  await reader.cancel().catch(() => undefined);
  return { events, closed };
}

describe('Videos read & status (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    process.env.STORAGE_PUBLIC_HOST = GATEWAY_PUBLIC_HOST;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.listen(0);
    const { port } = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    // Give any SSE-spawned QueueEvents (ioredis) connections time to close
    // before tearing the app down, so Jest exits without open-handle warnings.
    await new Promise((r) => setTimeout(r, 500));
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let token = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return res.body.access_token as string;
  }

  async function channelIdForEmail(email: string): Promise<string> {
    const user = await userRepository.findOneOrFail({ where: { email } });
    const channel = await channelRepository.findOneOrFail({
      where: { user_id: user.id },
    });
    return channel.id;
  }

  let seedCounter = 0;
  async function seedVideo(
    channelId: string,
    status: VideoStatus,
    extra: Partial<Video> = {},
  ): Promise<Video> {
    seedCounter += 1;
    const video = videoRepository.create({
      public_id: `seed${seedCounter}${status.slice(0, 3)}`,
      channel_id: channelId,
      status,
      title: 'Seeded video',
      storage_key: 'videos/seed/source',
      ...extra,
    });
    return videoRepository.save(video);
  }

  // ── 1. Read with visibility rules (GET /videos/:publicId) ──────────────────

  describe('GET /videos/:publicId', () => {
    it('returns the public DTO of a ready video to an anonymous caller', async () => {
      const email = 'read-owner@streamtube.local';
      await registerConfirmAndLogin(email);
      const channelId = await channelIdForEmail(email);
      const seeded = await seedVideo(channelId, VideoStatus.READY, {
        duration_seconds: 42,
        metadata: { codec: 'h264', width: 1920 },
        thumbnail_key: 'videos/seed/thumb.jpg',
      });

      const res = await request(app.getHttpServer()).get(
        `/videos/${seeded.public_id}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.publicId).toBe(seeded.public_id);
      expect(res.body.status).toBe('ready');
      expect(res.body.title).toBe('Seeded video');
      expect(res.body.durationSeconds).toBe(42);
      expect(res.body.metadata).toEqual({ codec: 'h264', width: 1920 });
      expect(typeof res.body.thumbnailUrl).toBe('string');
      expect(res.body.thumbnailUrl).toContain('storage-gateway:9000');
      expect(typeof res.body.createdAt).toBe('string');
      // Internal fields must never leak.
      expect(res.body.id).toBeUndefined();
      expect(res.body.storageKey).toBeUndefined();
      expect(res.body.channelId).toBeUndefined();
    });

    it('hides a processing video from an anonymous caller as 404', async () => {
      const email = 'read-owner2@streamtube.local';
      await registerConfirmAndLogin(email);
      const channelId = await channelIdForEmail(email);
      const seeded = await seedVideo(channelId, VideoStatus.PROCESSING);

      const res = await request(app.getHttpServer()).get(
        `/videos/${seeded.public_id}`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('lets the owner read their own processing video', async () => {
      const email = 'read-owner3@streamtube.local';
      const token = await registerConfirmAndLogin(email);
      const channelId = await channelIdForEmail(email);
      const seeded = await seedVideo(channelId, VideoStatus.PROCESSING);

      const res = await request(app.getHttpServer())
        .get(`/videos/${seeded.public_id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processing');
      expect(res.body).toHaveProperty('progress'); // present (number or null)
    });
  });

  // ── 2. Live status stream (GET /videos/:publicId/status, SSE) ──────────────

  describe('GET /videos/:publicId/status (SSE)', () => {
    it('streams an initial { status, progress } event over text/event-stream', async () => {
      const email = 'sse-owner@streamtube.local';
      const token = await registerConfirmAndLogin(email);
      const channelId = await channelIdForEmail(email);
      const seeded = await seedVideo(channelId, VideoStatus.PROCESSING);

      const res = await fetch(`${baseUrl}/videos/${seeded.public_id}/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const { events } = await collectSseUntilClose(res, 3000);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          status: 'processing',
          progress: null,
        }),
      );
      // let the server tear down the QueueEvents (ioredis) connection
      await new Promise((r) => setTimeout(r, 800));
    });

    it('closes the stream immediately when the video is already in a terminal state', async () => {
      const email = 'sse-owner2@streamtube.local';
      const token = await registerConfirmAndLogin(email);
      const channelId = await channelIdForEmail(email);
      const seeded = await seedVideo(channelId, VideoStatus.READY);

      const res = await fetch(`${baseUrl}/videos/${seeded.public_id}/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
      });

      expect(res.status).toBe(200);
      const { events, closed } = await collectSseUntilClose(res, 5000);
      expect(events.some((e) => e.status === 'ready')).toBe(true);
      expect(closed).toBe(true); // stream ended rather than staying open
    });

    it('rejects the status stream without a token (401)', async () => {
      const email = 'sse-owner3@streamtube.local';
      await registerConfirmAndLogin(email);
      const channelId = await channelIdForEmail(email);
      const seeded = await seedVideo(channelId, VideoStatus.PROCESSING);

      const res = await request(app.getHttpServer()).get(
        `/videos/${seeded.public_id}/status`,
      );

      expect(res.status).toBe(401);
    });
  });
});
