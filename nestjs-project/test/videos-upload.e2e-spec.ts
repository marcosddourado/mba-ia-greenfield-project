import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';

// The API reaches MinIO internally at `minio:9000`; presigned URLs handed to the
// browser are signed against the PUBLIC host. In prod that is `localhost:9000`,
// which — inside this container — resolves to the container itself. Point the
// presigner at the Compose gateway (Host-preserving, reachable) so a real
// in-container PUT to a presigned URL works, exactly like the storage
// integration test. Must be set BEFORE ConfigModule loads the storage factory.
const GATEWAY_PUBLIC_HOST = 'http://storage-gateway:9000';

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let queue: Queue;
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
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const token = await captureConfirmationToken(email);
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

  async function createDraft(
    accessToken: string,
    body: Record<string, unknown> = {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 52428800,
      title: 'My clip',
    },
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  // ── 1. Draft pre-registration (POST /videos) ──────────────────────────────

  describe('POST /videos', () => {
    it('creates a draft and initiates the multipart upload', async () => {
      const email = 'owner-draft@streamtube.local';
      const token = await registerConfirmAndLogin(email);

      const res = await createDraft(token);

      expect(res.status).toBe(201);
      expect(res.body.publicId).toEqual(expect.any(String));
      expect(res.body.publicId.length).toBeGreaterThan(0);
      expect(res.body.status).toBe('draft');
      expect(res.body.uploadId).toEqual(expect.any(String));
      expect(res.body.uploadId.length).toBeGreaterThan(0);
      expect(typeof res.body.partSize).toBe('number');
      expect(typeof res.body.partCount).toBe('number');

      const video = await videoRepository.findOneOrFail({
        where: { public_id: res.body.publicId },
      });
      expect(video.status).toBe('draft');
      expect(video.upload_id).toBeTruthy();
      expect(video.channel_id).toBe(await channelIdForEmail(email));
    });

    it('rejects a file exceeding the 10 GB ceiling with FILE_TOO_LARGE', async () => {
      const token = await registerConfirmAndLogin('owner-big@streamtube.local');

      const res = await createDraft(token, {
        filename: 'huge.mp4',
        contentType: 'video/mp4',
        sizeBytes: 10737418241,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('FILE_TOO_LARGE');
      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: expect.any(Number),
          error: expect.any(String),
          message: expect.anything(),
        }),
      );
      expect(await videoRepository.count()).toBe(0);
    });

    it('rejects a non-video contentType with UNSUPPORTED_MEDIA_TYPE', async () => {
      const token = await registerConfirmAndLogin('owner-pdf@streamtube.local');

      const res = await createDraft(token, {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });

      expect(res.status).toBe(415);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(await videoRepository.count()).toBe(0);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await request(app.getHttpServer()).post('/videos').send({
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      });

      expect(res.status).toBe(401);
      expect(await videoRepository.count()).toBe(0);
    });
  });

  // ── 2. Upload handshake (part-urls, complete, abort) ──────────────────────

  describe('upload handshake', () => {
    it('issues presigned part URLs against the public gateway', async () => {
      const token = await registerConfirmAndLogin(
        'owner-parts@streamtube.local',
      );
      const draft = await createDraft(token);
      const publicId = draft.body.publicId as string;

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1, 2, 3] });

      expect(res.status).toBe(200);
      expect(res.body.parts).toHaveLength(3);
      for (const part of res.body.parts) {
        expect(part).toEqual(
          expect.objectContaining({
            partNumber: expect.any(Number),
            url: expect.any(String),
          }),
        );
        expect(part.url).toContain('storage-gateway:9000');
        expect(part.url).not.toContain('minio:9000');
      }
      expect(new Date(res.body.expiresAt).toString()).not.toBe('Invalid Date');
    });

    it('lets the owner complete the upload and transitions to processing', async () => {
      const email = 'owner-complete@streamtube.local';
      const token = await registerConfirmAndLogin(email);
      const draft = await createDraft(token);
      const publicId = draft.body.publicId as string;

      // Real single-part upload: presign, PUT a small body to the gateway, and
      // collect the genuine ETag so CompleteMultipartUpload succeeds against MinIO.
      const partUrlsRes = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/part-urls`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] });
      const partUrl = partUrlsRes.body.parts[0].url as string;
      const putRes = await fetch(partUrl, {
        method: 'PUT',
        body: 'streamtube-e2e-part-payload',
      });
      expect(putRes.status).toBe(200);
      const eTag = putRes.headers.get('etag');
      expect(eTag).toBeTruthy();

      const addSpy = jest.spyOn(queue, 'add');

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 1, eTag: eTag as string }] });

      expect(res.status).toBe(200);
      expect(res.body.publicId).toBe(publicId);
      expect(res.body.status).toBe('processing');

      const video = await videoRepository.findOneOrFail({
        where: { public_id: publicId },
      });
      expect(video.status).toBe('processing');
      expect(video.upload_id).toBeNull();

      expect(addSpy).toHaveBeenCalledWith('process', { videoId: video.id });
      addSpy.mockRestore();
    });

    it('rejects complete by an authenticated non-owner with FORBIDDEN_NOT_OWNER', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'owner-2@streamtube.local',
      );
      const draft = await createDraft(ownerToken);
      const publicId = draft.body.publicId as string;

      const strangerToken = await registerConfirmAndLogin(
        'stranger@streamtube.local',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ parts: [{ partNumber: 1, eTag: '"etag-1"' }] });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN_NOT_OWNER');

      const video = await videoRepository.findOneOrFail({
        where: { public_id: publicId },
      });
      expect(video.status).toBe('draft');
    });
  });
});
