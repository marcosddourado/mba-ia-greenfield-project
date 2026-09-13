import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { JwtPayload } from '../../auth/auth.types';
import { Video } from '../entities/video.entity';
import {
  ForbiddenNotOwnerException,
  VideoNotFoundException,
} from '../exceptions/video.exceptions';

/**
 * Authorizes owner-only video actions: resolves the video by its `publicId`
 * route param, loads its channel, and asserts the channel belongs to the
 * authenticated user (`Channel.user_id === user.sub`), per the phase-03
 * Authorization Matrix. Runs after the inherited JWT auth guard (which
 * populates `request.user`).
 */
@Injectable()
export class VideoOwnerGuard implements CanActivate {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      params: { publicId: string };
      user: JwtPayload;
    }>();

    const video = await this.videoRepository.findOne({
      where: { public_id: request.params.publicId },
      relations: { channel: true },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== request.user.sub) {
      throw new ForbiddenNotOwnerException();
    }

    return true;
  }
}
