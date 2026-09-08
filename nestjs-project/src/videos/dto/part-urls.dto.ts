import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsInt, Max, Min } from 'class-validator';

export class PartUrlsDto {
  /** Part numbers to presign — each an integer 1..10000 (S3 multipart limit). */
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10000, { each: true })
  partNumbers: number[];
}

export class PartUrlDto {
  @ApiProperty()
  partNumber: number;

  @ApiProperty({ description: 'Presigned gateway UploadPart URL' })
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  parts: PartUrlDto[];

  @ApiProperty({ description: 'ISO-8601 expiry of the presigned URLs' })
  expiresAt: string;
}
