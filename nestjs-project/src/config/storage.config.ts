import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Internal MinIO/S3 endpoint used by the API for multipart control-plane
  // operations (create/complete/abort). Reached via the Compose service name.
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  // Public gateway endpoint the browser reaches. Presigned URLs are signed
  // against this host so the internal `minio:9000` is never exposed (masked
  // gateway — per phase-03-videos/TD-04, TD-08).
  publicHost: process.env.STORAGE_PUBLIC_HOST || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
  accessKey: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretKey: process.env.STORAGE_SECRET_KEY || 'streamtube-secret',
  // MinIO does not serve virtual-host style buckets — path style is required.
  forcePathStyle: true,
}));
