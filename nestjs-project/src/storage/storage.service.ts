import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { PRESIGN_EXPIRES_IN_SECONDS } from './storage.constants';

/** A part reported by the browser after a successful presigned PUT. */
export interface CompletedPart {
  ETag: string;
  PartNumber: number;
}

/**
 * Adapter over the S3/MinIO object storage. Control-plane operations
 * (create/complete/abort multipart) run against the INTERNAL endpoint reached
 * by the API over the Compose network; presigned URLs handed to the browser are
 * signed against the PUBLIC gateway host so the SigV4 host matches what the
 * browser hits — the internal `minio:9000` is never exposed (masked gateway,
 * per phase-03-videos/TD-04, TD-08).
 */
@Injectable()
export class StorageService {
  private readonly bucket: string;
  private readonly controlPlane: S3Client;
  private readonly presigner: S3Client;

  constructor(
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    const credentials = {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    };
    this.controlPlane = new S3Client({
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      region: config.region,
      credentials,
    });
    this.presigner = new S3Client({
      endpoint: config.publicHost,
      forcePathStyle: config.forcePathStyle,
      region: config.region,
      credentials,
    });
  }

  /** Starts a multipart upload and returns the S3 `UploadId`. */
  async createMultipartUpload(
    key: string,
    contentType?: string,
  ): Promise<string> {
    const result = await this.controlPlane.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error(
        'Storage did not return an UploadId for the multipart upload',
      );
    }
    return result.UploadId;
  }

  /** Presigns a single `UploadPart` URL for the browser to PUT directly. */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
    );
  }

  /** Assembles the object from the parts reported by the browser. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.controlPlane.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  /** Cancels an in-progress multipart upload and discards its parts. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.controlPlane.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /**
   * Presigns a GET for streaming. `Range` is added by the client at request
   * time (it is not a signed header), so byte-range requests work against the URL.
   */
  async presignGet(key: string): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
    );
  }

  /** Presigns a GET that forces a download with the given filename. */
  async presignDownload(key: string, filename: string): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      }),
      { expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
    );
  }
}
