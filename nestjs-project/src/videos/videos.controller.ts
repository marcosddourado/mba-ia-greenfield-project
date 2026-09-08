import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChannelsService } from '../channels/channels.service';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto, CreateVideoResponseDto } from './dto/create-video.dto';
import {
  CompleteUploadDto,
  CompleteUploadResponseDto,
} from './dto/complete-upload.dto';
import { PartUrlsDto, PartUrlsResponseDto } from './dto/part-urls.dto';
import { VideoOwnerGuard } from './guards/video-owner.guard';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Pre-register a draft video and start the multipart upload',
    description:
      'Creates a draft video under the authenticated user’s channel, opens the masked-gateway multipart upload, and returns the uploadId plus recommended part sizing.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload initiated',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error, or sizeBytes exceeds the 10 GB ceiling',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'contentType is not video/*',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) {
      // Invariant: every user gets a channel on registration (cascade).
      throw new InternalServerErrorException(
        'Authenticated user has no channel',
      );
    }
    return this.videosService.createDraft(channel.id, dto);
  }

  @Post(':publicId/upload/part-urls')
  @UseGuards(VideoOwnerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue presigned UploadPart URLs',
    description:
      'Presigns UploadPart URLs (against the public gateway host) for the requested part numbers. Supports resume by requesting only missing parts.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs issued',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own the video’s channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'publicId does not resolve',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft/uploading state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async issuePartUrls(
    @Param('publicId') publicId: string,
    @Body() dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.issuePartUrls(publicId, dto.partNumbers);
  }

  @Post(':publicId/upload/complete')
  @UseGuards(VideoOwnerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete the multipart upload',
    description:
      'Finalizes the multipart upload with the client-collected ETags, transitions the video to processing, and enqueues the video-processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; video transitioned to processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, or parts rejected by storage (INVALID_PARTS)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own the video’s channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'publicId does not resolve',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft/uploading state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(publicId, dto.parts);
  }

  @Delete(':publicId/upload')
  @UseGuards(VideoOwnerGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort an in-progress multipart upload',
    description:
      'Aborts the multipart upload and marks the draft failed. Idempotent cleanup.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user does not own the video’s channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'publicId does not resolve',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(@Param('publicId') publicId: string): Promise<void> {
    await this.videosService.abortUpload(publicId);
  }
}
