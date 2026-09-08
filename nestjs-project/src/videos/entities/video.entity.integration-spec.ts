import { DataSource, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
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

  it('should default status to draft when omitted', async () => {
    const channel = await createChannel();
    const video = videoRepository.create({
      public_id: 'abc1234567890xyz',
      channel_id: channel.id,
    });

    const saved = await videoRepository.save(video);

    expect(saved.id).toBeDefined();
    expect(saved.status).toBe(VideoStatus.DRAFT);
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique public_id constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        public_id: 'dup1234567890abc',
        channel_id: channel.id,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'dup1234567890abc',
          channel_id: channel.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video whose channel_id does not exist', async () => {
    const video = videoRepository.create({
      public_id: 'orphan1234567890',
      channel_id: '00000000-0000-0000-0000-000000000000',
    });

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should persist size_bytes above 2^31 (bigint, 10 GB ceiling)', async () => {
    const channel = await createChannel();
    const tenGigabytes = (10 * 1024 * 1024 * 1024).toString(); // 10737418240

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: 'big12345678901234'.slice(0, 16),
        channel_id: channel.id,
        size_bytes: tenGigabytes,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(tenGigabytes);
    expect(Number(found.size_bytes)).toBeGreaterThan(2 ** 31);
  });
});
