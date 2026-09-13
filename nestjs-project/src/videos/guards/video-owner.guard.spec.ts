import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from '../entities/video.entity';
import {
  ForbiddenNotOwnerException,
  VideoNotFoundException,
} from '../exceptions/video.exceptions';
import { VideoOwnerGuard } from './video-owner.guard';

describe('VideoOwnerGuard (unit)', () => {
  let guard: VideoOwnerGuard;
  let videoRepository: jest.Mocked<Pick<Repository<Video>, 'findOne'>>;

  beforeEach(async () => {
    videoRepository = { findOne: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        VideoOwnerGuard,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
      ],
    }).compile();

    guard = moduleRef.get(VideoOwnerGuard);
  });

  function contextFor(publicId: string, userSub: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          params: { publicId },
          user: { sub: userSub, email: 'user@streamtube.local' },
        }),
        getResponse: () => ({}),
        getNext: () => jest.fn(),
      }),
      getClass: () => Object,
      getHandler: () => jest.fn(),
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => ({}) as never,
      switchToWs: () => ({}) as never,
      getType: () => 'http',
    } as unknown as ExecutionContext;
  }

  function videoOwnedBy(userId: string): Video {
    return { public_id: 'pub123', channel: { user_id: userId } } as Video;
  }

  it('authorizes the channel owner', async () => {
    videoRepository.findOne.mockResolvedValue(videoOwnedBy('user-1'));

    await expect(
      guard.canActivate(contextFor('pub123', 'user-1')),
    ).resolves.toBe(true);
  });

  it('rejects an authenticated non-owner with FORBIDDEN_NOT_OWNER', async () => {
    videoRepository.findOne.mockResolvedValue(videoOwnedBy('user-1'));

    await expect(
      guard.canActivate(contextFor('pub123', 'user-2')),
    ).rejects.toBeInstanceOf(ForbiddenNotOwnerException);
  });

  it('rejects an unknown publicId with VIDEO_NOT_FOUND', async () => {
    videoRepository.findOne.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor('missing', 'user-1')),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
