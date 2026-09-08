import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateVideoDto {
  /** Original filename of the source video. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /**
   * MIME type of the source. Presence/format is validated here; the `video/*`
   * allowlist (415 UNSUPPORTED_MEDIA_TYPE) is a domain rule enforced by the
   * service so it maps to the Error Catalog code, not a generic 400.
   */
  @IsString()
  @IsNotEmpty()
  contentType: string;

  /**
   * Source size in bytes. A positive integer is required here; the 10 GB
   * ceiling (400 FILE_TOO_LARGE) is a domain rule enforced by the service.
   */
  @IsInt()
  @Min(1)
  sizeBytes: number;

  /** Optional display title. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}

export class CreateVideoResponseDto {
  @ApiProperty()
  publicId: string;

  @ApiProperty({ example: 'draft' })
  status: string;

  @ApiProperty({ description: 'Storage multipart UploadId' })
  uploadId: string;

  @ApiProperty({ description: 'Recommended part size in bytes' })
  partSize: number;

  @ApiProperty({ description: 'Recommended number of parts for sizeBytes' })
  partCount: number;
}
