import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import queueConfig from '../config/queue.config';
import { StorageService } from '../storage/storage.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { Video, VideoStatus } from './entities/video.entity';
import {
  FileTooLargeException,
  InvalidPartsException,
  UnsupportedMediaTypeException,
  UploadNotInProgressException,
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/video.exceptions';
import { VideosService } from './videos.service';

// TypeORM's `create`/`save` are overloaded; typing the mock via
// `jest.Mocked<Pick<Repository>>` fights those overloads under `tsc`. A plain
// jest.Mock triple is sufficient here and is injected via the repository token.
type RepoMock = {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
};

function publicIdConflict(): QueryFailedError {
  const err = new QueryFailedError('insert', undefined, new Error());
  Object.assign(err, {
    code: '23505',
    detail: 'Key (public_id)=(dup) already exists.',
  });
  return err;
}

describe('VideosService (unit)', () => {
  let service: VideosService;
  let repo: RepoMock;
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'createMultipartUpload'
      | 'presignUploadPart'
      | 'completeMultipartUpload'
      | 'abortMultipartUpload'
      | 'presignGet'
      | 'presignDownload'
    >
  >;
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((dto) => dto as Video),
      save: jest.fn((entity) => Promise.resolve(entity as Video)),
      findOne: jest.fn(),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPart: jest.fn().mockResolvedValue('https://gw/part'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignGet: jest.fn().mockResolvedValue('https://gw/stream'),
      presignDownload: jest.fn().mockResolvedValue('https://gw/download'),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
        { provide: queueConfig.KEY, useValue: { host: 'redis', port: 6379 } },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  const draftInput = {
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    sizeBytes: 250 * 1024 * 1024,
  };

  describe('createDraft', () => {
    it('persists a draft, opens the multipart upload, and returns the uploadId + part plan', async () => {
      const result = await service.createDraft('channel-1', draftInput);

      expect(result.uploadId).toBe('upload-1');
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.publicId).toHaveLength(11);
      // 250 MiB / 100 MiB recommended part size → 3 parts.
      expect(result.partCount).toBe(3);

      const saved = repo.create.mock.calls[0][0] as Partial<Video>;
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.channel_id).toBe('channel-1');
      expect(saved.size_bytes).toBe(String(draftInput.sizeBytes));
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.publicId}/source`,
        'video/mp4',
      );
    });

    it('retries on a public_id collision and never surfaces an error', async () => {
      repo.save
        .mockRejectedValueOnce(publicIdConflict())
        .mockImplementation((entity) => Promise.resolve(entity as Video));

      const result = await service.createDraft('channel-1', draftInput);

      expect(result.uploadId).toBe('upload-1');
      // first draft save (rejected) + retry draft save + upload_id update = 3.
      expect(repo.save).toHaveBeenCalledTimes(3);
    });

    it('rejects a non-video content type with UNSUPPORTED_MEDIA_TYPE', async () => {
      await expect(
        service.createDraft('channel-1', {
          ...draftInput,
          contentType: 'image/png',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('rejects a size beyond the 10 GB ceiling with FILE_TOO_LARGE', async () => {
      await expect(
        service.createDraft('channel-1', {
          ...draftInput,
          sizeBytes: 10_737_418_241,
        }),
      ).rejects.toBeInstanceOf(FileTooLargeException);
    });
  });

  describe('completeUpload', () => {
    function uploadingVideo(): Video {
      return {
        id: 'vid-1',
        public_id: 'pub123',
        status: VideoStatus.UPLOADING,
        upload_id: 'upload-1',
        storage_key: 'videos/pub123/source',
      } as Video;
    }

    it('completes the upload, moves to processing, and enqueues one job', async () => {
      repo.findOne.mockResolvedValue(uploadingVideo());

      const result = await service.completeUpload('pub123', [
        { partNumber: 1, eTag: '"etag1"' },
      ]);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/pub123/source',
        'upload-1',
        [{ ETag: '"etag1"', PartNumber: 1 }],
      );
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith('process', { videoId: 'vid-1' });
    });

    it('throws VIDEO_NOT_FOUND for an unknown publicId', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.completeUpload('missing', [{ partNumber: 1, eTag: 'e' }]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws UPLOAD_NOT_IN_PROGRESS when the video is already processing', async () => {
      repo.findOne.mockResolvedValue({
        ...uploadingVideo(),
        status: VideoStatus.PROCESSING,
      } as Video);
      await expect(
        service.completeUpload('pub123', [{ partNumber: 1, eTag: 'e' }]),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);
    });

    it('maps a storage rejection to INVALID_PARTS', async () => {
      repo.findOne.mockResolvedValue(uploadingVideo());
      storage.completeMultipartUpload.mockRejectedValue(new Error('bad parts'));
      await expect(
        service.completeUpload('pub123', [{ partNumber: 1, eTag: 'e' }]),
      ).rejects.toBeInstanceOf(InvalidPartsException);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('aborts the multipart upload and marks the video failed', async () => {
      const video = {
        id: 'vid-1',
        public_id: 'pub123',
        status: VideoStatus.UPLOADING,
        upload_id: 'upload-1',
        storage_key: 'videos/pub123/source',
      } as Video;
      repo.findOne.mockResolvedValue(video);

      await service.abortUpload('pub123');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/pub123/source',
        'upload-1',
      );
      expect(video.status).toBe(VideoStatus.FAILED);
      expect(video.upload_id).toBeNull();
    });

    it('is idempotent — a second call with no upload in progress does not touch storage', async () => {
      repo.findOne.mockResolvedValue({
        id: 'vid-1',
        public_id: 'pub123',
        status: VideoStatus.FAILED,
        upload_id: null,
        storage_key: 'videos/pub123/source',
      } as Video);

      await expect(service.abortUpload('pub123')).resolves.toBeUndefined();
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws VIDEO_NOT_FOUND for an unknown publicId', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.abortUpload('missing')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });

  describe('getByPublicId (visibility)', () => {
    const OWNER_ID = 'user-owner';

    function videoInStatus(status: VideoStatus): Video {
      return {
        id: 'vid-1',
        public_id: 'pub123',
        status,
        channel: { user_id: OWNER_ID },
      } as Video;
    }

    it('returns a ready video to an anonymous caller', async () => {
      repo.findOne.mockResolvedValue(videoInStatus(VideoStatus.READY));
      const video = await service.getByPublicId('pub123');
      expect(video.status).toBe(VideoStatus.READY);
    });

    it('hides a processing video from an anonymous caller (VIDEO_NOT_FOUND)', async () => {
      repo.findOne.mockResolvedValue(videoInStatus(VideoStatus.PROCESSING));
      await expect(service.getByPublicId('pub123')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('hides a processing video from an authenticated non-owner (VIDEO_NOT_FOUND)', async () => {
      repo.findOne.mockResolvedValue(videoInStatus(VideoStatus.PROCESSING));
      await expect(
        service.getByPublicId('pub123', 'someone-else'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('returns a processing/draft/failed video to its owner', async () => {
      for (const status of [
        VideoStatus.DRAFT,
        VideoStatus.PROCESSING,
        VideoStatus.FAILED,
      ]) {
        repo.findOne.mockResolvedValue(videoInStatus(status));
        const video = await service.getByPublicId('pub123', OWNER_ID);
        expect(video.status).toBe(status);
      }
    });

    it('throws VIDEO_NOT_FOUND for an unknown publicId', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.getByPublicId('missing', OWNER_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('getStreamUrl / getDownloadUrl (delivery)', () => {
    function videoInStatus(status: VideoStatus): Video {
      return {
        id: 'vid-1',
        public_id: 'pub123',
        status,
        storage_key: 'videos/pub123/source',
        original_filename: 'clip.mp4',
      } as Video;
    }

    it('presigns a Range GET URL for a ready video (stream)', async () => {
      repo.findOne.mockResolvedValue(videoInStatus(VideoStatus.READY));
      const url = await service.getStreamUrl('pub123');
      expect(url).toBe('https://gw/stream');
      expect(storage.presignGet).toHaveBeenCalledWith('videos/pub123/source');
    });

    it('presigns an attachment GET URL for a ready video (download)', async () => {
      repo.findOne.mockResolvedValue(videoInStatus(VideoStatus.READY));
      const url = await service.getDownloadUrl('pub123');
      expect(url).toBe('https://gw/download');
      expect(storage.presignDownload).toHaveBeenCalledWith(
        'videos/pub123/source',
        'clip.mp4',
      );
    });

    it('throws VIDEO_NOT_READY when streaming a non-ready video', async () => {
      repo.findOne.mockResolvedValue(videoInStatus(VideoStatus.PROCESSING));
      await expect(service.getStreamUrl('pub123')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
      expect(storage.presignGet).not.toHaveBeenCalled();
    });

    it('throws VIDEO_NOT_READY when downloading a non-ready video', async () => {
      repo.findOne.mockResolvedValue(videoInStatus(VideoStatus.PROCESSING));
      await expect(service.getDownloadUrl('pub123')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
      expect(storage.presignDownload).not.toHaveBeenCalled();
    });

    it('throws VIDEO_NOT_FOUND for an unknown publicId', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getStreamUrl('missing')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });
});
