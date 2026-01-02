import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class UploadDto {
  @ApiProperty({ example: 'avatar', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ type: 'string', format: 'binary', required: true })
  file: Express.Multer.File;
}
