import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import execa from 'execa';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { thumbnailKeyFor } from '../video-storage-keys';
import { Video, VideoStatus } from '../entities/video.entity';

interface VideoJobData {
  videoId: string;
}

/** Raw `ffprobe -print_format json` shape we consume (duration + full JSON). */
interface FfprobeResult {
  format?: { duration?: string };
}

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/**
 * Consumes `video-processing` jobs (per phase-03-videos/TD-02, TD-03): pulls the
 * source object onto disk, runs `ffprobe` (duration + metadata) and `ffmpeg`
 * (single-frame thumbnail) via `execa` (per TD-06), uploads the thumbnail, and
 * transitions the video to `ready`. Idempotent — re-running over the same source
 * recomputes the same result. On any failure the `failed` worker event marks the
 * video `failed` without crashing the worker.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: job.data.videoId },
    });
    if (!video || !video.storage_key) {
      throw new Error(`Video ${job.data.videoId} not found or has no source`);
    }
    await job.updateProgress(10);

    const workdir = await mkdtemp(join(tmpdir(), 'video-'));
    const sourcePath = join(workdir, 'source');
    const thumbnailPath = join(workdir, 'thumbnail.jpg');

    try {
      await this.storage.downloadToFile(video.storage_key, sourcePath);
      await job.updateProgress(30);

      // ffprobe and ffmpeg both read the source and produce independent outputs
      // (metadata vs a thumbnail file), so they run concurrently.
      const [metadata] = await Promise.all([
        this.probe(sourcePath),
        this.generateThumbnail(sourcePath, thumbnailPath),
      ]);
      const durationSeconds = Math.round(
        Number(metadata.format?.duration ?? 0),
      );

      const thumbnailKey = thumbnailKeyFor(video.public_id);
      await this.storage.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        THUMBNAIL_CONTENT_TYPE,
      );
      await job.updateProgress(90);

      await this.videoRepository.save({
        ...video,
        duration_seconds: durationSeconds,
        metadata: metadata as Record<string, unknown>,
        thumbnail_key: thumbnailKey,
        processed_at: new Date(),
        status: VideoStatus.READY,
      });
      await job.updateProgress(100);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  /** `ffprobe` → parsed JSON (duration under `format`, plus streams metadata). */
  private async probe(sourcePath: string): Promise<FfprobeResult> {
    const { stdout } = await execa('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      sourcePath,
    ]);
    return JSON.parse(stdout) as FfprobeResult;
  }

  /** `ffmpeg` → a single JPEG frame from the start of the video. */
  private async generateThumbnail(
    sourcePath: string,
    thumbnailPath: string,
  ): Promise<void> {
    await execa('ffmpeg', [
      '-y',
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      thumbnailPath,
    ]);
  }

  /**
   * Background failure handler (per TD-07): marks the video `failed` so the
   * status lifecycle reaches its terminal state. Runs in an event-handler
   * context, so it logs rather than rethrows (a throw here would not help and
   * could destabilize the worker).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoJobData>): Promise<void> {
    const videoId = job?.data?.videoId;
    if (!videoId) {
      return;
    }
    try {
      await this.videoRepository.update(
        { id: videoId },
        { status: VideoStatus.FAILED },
      );
    } catch (err) {
      this.logger.error(
        `Failed to mark video ${videoId} as failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
