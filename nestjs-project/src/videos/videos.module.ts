import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoOwnerGuard } from './guards/video-owner.guard';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    QueueModule,
    ChannelsModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoOwnerGuard],
  exports: [VideosService, TypeOrmModule],
})
export class VideosModule {}
