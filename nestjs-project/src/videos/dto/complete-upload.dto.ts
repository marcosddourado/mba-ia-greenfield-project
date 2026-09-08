import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletePartDto {
  /** Part number reported by the browser after a successful presigned PUT. */
  @IsInt()
  @Min(1)
  @Max(10000)
  partNumber: number;

  /** ETag returned by storage for the uploaded part. */
  @IsString()
  @IsNotEmpty()
  eTag: string;
}

export class CompleteUploadDto {
  /** Ordered part manifest collected by the browser. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletePartDto)
  parts: CompletePartDto[];
}

export class CompleteUploadResponseDto {
  @ApiProperty()
  publicId: string;

  @ApiProperty({ example: 'processing' })
  status: string;
}
