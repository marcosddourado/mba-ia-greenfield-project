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

describe('videos-delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    // Presigned URLs are signed against the public gateway host; set it before
    // ConfigModule loads so the SigV4 host matches what the browser would hit.
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
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function registerConfirmAndLogin(email: string): Promise<void> {
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
      public_id: `del${seedCounter}${status.slice(0, 3)}`,
      channel_id: channelId,
      status,
      title: 'Seeded video',
      storage_key: 'videos/seed/source',
      original_filename: 'clip.mp4',
      ...extra,
    });
    return videoRepository.save(video);
  }

  async function seededChannel(email: string): Promise<string> {
    await registerConfirmAndLogin(email);
    return channelIdForEmail(email);
  }

  // ── 1. Streaming redirect (GET /videos/:publicId/stream) ───────────────────

  describe('GET /videos/:publicId/stream', () => {
    it('redirects a ready video to a presigned public-gateway URL', async () => {
      const channelId = await seededChannel('del-stream1@streamtube.local');
      const seeded = await seedVideo(channelId, VideoStatus.READY);

      const res = await request(app.getHttpServer())
        .get(`/videos/${seeded.public_id}/stream`)
        .redirects(0);

      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(location).toContain('storage-gateway:9000');
      expect(location).not.toContain('minio:9000');
      // The 302 carries no JSON payload (Express supplies only its default
      // "Found. Redirecting to …" redirect text, never an error envelope).
      expect(res.body).toEqual({});
    });

    it('rejects streaming a non-ready video with 409 VIDEO_NOT_READY', async () => {
      const channelId = await seededChannel('del-stream2@streamtube.local');
      const seeded = await seedVideo(channelId, VideoStatus.PROCESSING);

      const res = await request(app.getHttpServer())
        .get(`/videos/${seeded.public_id}/stream`)
        .redirects(0);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
      expect(res.headers.location).toBeUndefined();
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown publicId', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/does-not-exist/stream')
        .redirects(0);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  // ── 2. Download redirect (GET /videos/:publicId/download) ──────────────────

  describe('GET /videos/:publicId/download', () => {
    it('redirects a ready video to a presigned attachment URL', async () => {
      const channelId = await seededChannel('del-download1@streamtube.local');
      const seeded = await seedVideo(channelId, VideoStatus.READY);

      const res = await request(app.getHttpServer())
        .get(`/videos/${seeded.public_id}/download`)
        .redirects(0);

      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(location).toContain('storage-gateway:9000');
      expect(location).not.toContain('minio:9000');
      // The presigned URL encodes response-content-disposition = attachment.
      const decoded = decodeURIComponent(location);
      expect(decoded).toContain('response-content-disposition');
      expect(decoded).toContain('attachment');
      expect(decoded).toContain('clip.mp4');
    });

    it('rejects downloading a non-ready video with 409 VIDEO_NOT_READY', async () => {
      const channelId = await seededChannel('del-download2@streamtube.local');
      const seeded = await seedVideo(channelId, VideoStatus.PROCESSING);

      const res = await request(app.getHttpServer())
        .get(`/videos/${seeded.public_id}/download`)
        .redirects(0);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
      expect(res.headers.location).toBeUndefined();
    });
  });
});
