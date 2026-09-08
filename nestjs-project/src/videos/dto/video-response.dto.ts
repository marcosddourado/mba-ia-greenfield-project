import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty()
  publicId: string;

  @ApiProperty({ type: String, nullable: true })
  title: string | null;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '0..100 while processing (live value via the SSE status channel)',
  })
  progress: number | null;

  @ApiProperty({ type: Number, nullable: true })
  durationSeconds: number | null;

  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'ffprobe-derived metadata (codecs, resolution, bitrate, framerate)',
  })
  metadata: Record<string, unknown> | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned gateway GET URL for the thumbnail',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ description: 'ISO-8601 creation timestamp' })
  createdAt: string;
}
