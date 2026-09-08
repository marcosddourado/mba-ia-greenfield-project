import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { customAlphabet } from 'nanoid';
import { Repository } from 'typeorm';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import { PRESIGN_EXPIRES_IN_SECONDS } from '../storage/storage.constants';
import { StorageService, type CompletedPart } from '../storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { Video, VideoStatus } from './entities/video.entity';
import {
  MAX_FILE_SIZE_BYTES,
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_MAX_RETRIES,
  RECOMMENDED_PART_SIZE_BYTES,
} from './videos.constants';
import {
  FileTooLargeException,
  InvalidPartsException,
  UnsupportedMediaTypeException,
  UploadNotInProgressException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';

const PUBLIC_ID_COLUMN = 'public_id';
const PROCESS_JOB_NAME = 'process';

export interface CreateDraftInput {
  filename: string;
  contentType: string;
  sizeBytes: number;
  title?: string;
}

export interface CreateDraftResult {
  publicId: string;
  status: VideoStatus;
  uploadId: string;
  partSize: number;
  partCount: number;
}

export interface PartUrl {
  partNumber: number;
  url: string;
}

export interface IssuePartUrlsResult {
  parts: PartUrl[];
  expiresAt: string;
}

export interface CompletePart {
  partNumber: number;
  eTag: string;
}

export interface CompleteUploadResult {
  publicId: string;
  status: VideoStatus;
}

@Injectable()
export class VideosService {
  private readonly generateSlug = customAlphabet(
    PUBLIC_ID_ALPHABET,
    PUBLIC_ID_LENGTH,
  );

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
  ) {}

  /** Generates a candidate `public_id`. Isolated so tests can force a collision. */
  private generatePublicId(): string {
    return this.generateSlug();
  }

  private static storageKeyFor(publicId: string): string {
    return `videos/${publicId}/source`;
  }

  /**
   * Pre-registers a draft video and opens the multipart upload. Retries on the
   * rare `public_id` collision so the caller never sees a conflict error.
   */
  async createDraft(
    channelId: string,
    input: CreateDraftInput,
  ): Promise<CreateDraftResult> {
    if (!input.contentType.startsWith('video/')) {
      throw new UnsupportedMediaTypeException();
    }
    if (input.sizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    const video = await this.persistDraftWithUniquePublicId(channelId, input);
    const storageKey = VideosService.storageKeyFor(video.public_id);

    const uploadId = await this.storage.createMultipartUpload(
      storageKey,
      input.contentType,
    );
    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    const partCount = Math.max(
      1,
      Math.ceil(input.sizeBytes / RECOMMENDED_PART_SIZE_BYTES),
    );

    return {
      publicId: video.public_id,
      status: video.status,
      uploadId,
      partSize: RECOMMENDED_PART_SIZE_BYTES,
      partCount,
    };
  }

  private async persistDraftWithUniquePublicId(
    channelId: string,
    input: CreateDraftInput,
  ): Promise<Video> {
    for (let attempt = 0; ; attempt++) {
      const publicId = this.generatePublicId();
      const draft = this.videoRepository.create({
        public_id: publicId,
        channel_id: channelId,
        title: input.title ?? null,
        original_filename: input.filename,
        content_type: input.contentType,
        size_bytes: input.sizeBytes.toString(),
        status: VideoStatus.DRAFT,
        storage_key: VideosService.storageKeyFor(publicId),
      });

      try {
        return await this.videoRepository.save(draft);
      } catch (err) {
        if (
          attempt >= PUBLIC_ID_MAX_RETRIES ||
          !isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)
        ) {
          throw err;
        }
      }
    }
  }

  /** Presigns `UploadPart` URLs for the requested part numbers. */
  async issuePartUrls(
    publicId: string,
    partNumbers: number[],
  ): Promise<IssuePartUrlsResult> {
    const video = await this.getUploadableVideo(publicId);

    const parts: PartUrl[] = [];
    for (const partNumber of partNumbers) {
      const url = await this.storage.presignUploadPart(
        video.storage_key,
        video.upload_id,
        partNumber,
      );
      parts.push({ partNumber, url });
    }

    if (video.status === VideoStatus.DRAFT) {
      video.status = VideoStatus.UPLOADING;
      await this.videoRepository.save(video);
    }

    const expiresAt = new Date(
      Date.now() + PRESIGN_EXPIRES_IN_SECONDS * 1000,
    ).toISOString();

    return { parts, expiresAt };
  }

  /**
   * Completes the multipart upload, transitions the video to `processing`, and
   * enqueues exactly one `video-processing` job carrying the internal video id.
   */
  async completeUpload(
    publicId: string,
    parts: CompletePart[],
  ): Promise<CompleteUploadResult> {
    const video = await this.getUploadableVideo(publicId);

    if (parts.length === 0) {
      throw new InvalidPartsException();
    }

    const completedParts: CompletedPart[] = parts.map((part) => ({
      ETag: part.eTag,
      PartNumber: part.partNumber,
    }));

    try {
      await this.storage.completeMultipartUpload(
        video.storage_key,
        video.upload_id,
        completedParts,
      );
    } catch {
      throw new InvalidPartsException();
    }

    await this.videoRepository.save({
      ...video,
      status: VideoStatus.PROCESSING,
      upload_id: null,
    });

    await this.queue.add(PROCESS_JOB_NAME, { videoId: video.id });

    return { publicId: video.public_id, status: VideoStatus.PROCESSING };
  }

  /**
   * Aborts an in-progress multipart upload and marks the draft `failed`.
   * Idempotent: a second call (no upload in progress) is a no-op.
   */
  async abortUpload(publicId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.upload_id) {
      await this.storage.abortMultipartUpload(
        video.storage_key as string,
        video.upload_id,
      );
      video.upload_id = null;
    }

    if (video.status !== VideoStatus.FAILED) {
      video.status = VideoStatus.FAILED;
      await this.videoRepository.save(video);
    }
  }

  private async getUploadableVideo(
    publicId: string,
  ): Promise<Video & { upload_id: string; storage_key: string }> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const isUploadable =
      video.status === VideoStatus.DRAFT ||
      video.status === VideoStatus.UPLOADING;
    if (!isUploadable || !video.upload_id) {
      throw new UploadNotInProgressException();
    }
    return video as Video & { upload_id: string; storage_key: string };
  }
}
