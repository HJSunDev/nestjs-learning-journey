import { Controller, Post, UseInterceptors, UploadedFile, Body } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UploadDto } from './dto/upload.dto';
import { UploadService } from './upload.service';

@ApiTags('Upload')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post()
  @ApiOperation({ summary: '上传单个文件' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: '文件上传',
    type: UploadDto,
  })
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @Body() uploadDto: UploadDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.uploadService.upload(file);

    return {
      message: '文件上传成功',
      ...result,
    };
  }
}

