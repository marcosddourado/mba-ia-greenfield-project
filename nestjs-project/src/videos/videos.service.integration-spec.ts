import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

// The draft-persistence + collision behaviour under test is a DB contract; the
// storage handshake and the enqueue are exercised elsewhere, so both are stubbed.
const stubStorage = {
  createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
} as unknown as StorageService;

const stubQueue = {
  add: jest.fn().mockResolvedValue(undefined),
} as unknown as Queue;

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let service: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
    service = new VideosService(videoRepository, stubStorage, stubQueue);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Shared helper clears videos + tokens before channels/users in FK order —
    // other suites (auth) leave token rows that would block a bare users DELETE.
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({ email: 'owner@example.com', password: 'hashed' }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Owner',
        nickname: 'owner',
        user_id: user.id,
      }),
    );
  }

  const draftInput = {
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    sizeBytes: 1024,
  };

  it('persists a draft video with a unique public_id and returns the uploadId', async () => {
    const channel = await createChannel();

    const result = await service.createDraft(channel.id, draftInput);

    expect(result.uploadId).toBe('upload-id');
    expect(result.status).toBe(VideoStatus.DRAFT);

    const persisted = await videoRepository.findOne({
      where: { public_id: result.publicId },
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.channel_id).toBe(channel.id);
    expect(persisted?.status).toBe(VideoStatus.DRAFT);
    expect(persisted?.size_bytes).toBe('1024');
    expect(persisted?.upload_id).toBe('upload-id');
    expect(persisted?.storage_key).toBe(`videos/${result.publicId}/source`);
  });

  it('resolves a public_id collision by retrying against the DB unique index', async () => {
    const channel = await createChannel();
    const collidingId = 'COLLIDE1234';

    // Seed a row that already owns the id the generator will first produce.
    await videoRepository.save(
      videoRepository.create({
        public_id: collidingId,
        channel_id: channel.id,
        status: VideoStatus.DRAFT,
        storage_key: `videos/${collidingId}/source`,
      }),
    );

    const generateSpy = jest
      .spyOn(
        service as unknown as { generatePublicId: () => string },
        'generatePublicId',
      )
      .mockReturnValueOnce(collidingId) // first attempt collides
      .mockReturnValueOnce('FRESH123456'); // retry succeeds

    const result = await service.createDraft(channel.id, draftInput);

    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(result.publicId).toBe('FRESH123456');

    // The seeded id still resolves to exactly one row — no duplicate written.
    const collidingRows = await videoRepository.find({
      where: { public_id: collidingId },
    });
    expect(collidingRows).toHaveLength(1);
  });
});
