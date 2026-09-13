import { randomUUID } from 'crypto';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

// The API/worker reach MinIO internally at `minio:9000`; the browser (and this
// in-container test's `fetch`) reach it through the Caddy gateway, which passes
// the `Host` header through so SigV4 validates upstream. `localhost:9000` (the
// prod public host) would resolve to this container itself, so the test signs
// against the gateway's Compose service name instead — reachable AND consistent.
const INTERNAL_ENDPOINT = process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';
const GATEWAY_PUBLIC_HOST = 'http://storage-gateway:9000';
const BUCKET = process.env.STORAGE_BUCKET ?? 'streamtube-videos';

describe('StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let storageService: StorageService;
  let rawS3: S3Client;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    // registerAs reads process.env at load time — point the presigner at the
    // container-reachable gateway before ConfigModule loads the factory.
    process.env.STORAGE_PUBLIC_HOST = GATEWAY_PUBLIC_HOST;

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    storageService = moduleRef.get(StorageService);

    rawS3 = new S3Client({
      endpoint: INTERNAL_ENDPOINT,
      forcePathStyle: true,
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY ?? 'streamtube',
        secretAccessKey: process.env.STORAGE_SECRET_KEY ?? 'streamtube-secret',
      },
    });
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await rawS3
        .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
        .catch(() => undefined);
    }
    rawS3.destroy();
    await moduleRef.close();
  });

  function uniqueKey(): string {
    const key = `test/storage-spec/${randomUUID()}`;
    createdKeys.push(key);
    return key;
  }

  it('completes a multipart upload assembled from a presigned part URL', async () => {
    const key = uniqueKey();
    const body = 'streamtube multipart payload';

    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    expect(uploadId).toBeTruthy();

    const partUrl = await storageService.presignUploadPart(key, uploadId, 1);
    // AC #4 — presigned URL targets the public gateway, never `minio:9000`.
    expect(partUrl).toContain('storage-gateway:9000');
    expect(partUrl).not.toContain('minio:9000');

    const putRes = await fetch(partUrl, { method: 'PUT', body });
    expect(putRes.status).toBe(200);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    await storageService.completeMultipartUpload(key, uploadId, [
      { ETag: etag as string, PartNumber: 1 },
    ]);

    // The assembled object is now downloadable in full.
    const getUrl = await storageService.presignGet(key);
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(body);
  });

  it('aborts an in-progress multipart upload so it can no longer be completed', async () => {
    const key = uniqueKey();

    const uploadId = await storageService.createMultipartUpload(key);
    await storageService.abortMultipartUpload(key, uploadId);

    await expect(
      storageService.completeMultipartUpload(key, uploadId, [
        { ETag: '"deadbeef"', PartNumber: 1 },
      ]),
    ).rejects.toThrow();
  });

  it('presigns a GET that streams a byte range (206 Partial Content)', async () => {
    const key = uniqueKey();
    await rawS3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: 'range-streaming-fixture-body',
      }),
    );

    const url = await storageService.presignGet(key);
    expect(url).not.toContain('minio:9000');

    const res = await fetch(url, { headers: { Range: 'bytes=0-4' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('range');
  });

  it('presigns a download URL that forces content-disposition attachment', async () => {
    const key = uniqueKey();
    await rawS3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: 'downloadable-fixture-body',
      }),
    );

    const url = await storageService.presignDownload(key, 'my-video.mp4');
    expect(url).not.toContain('minio:9000');

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('my-video.mp4');
  });
});
