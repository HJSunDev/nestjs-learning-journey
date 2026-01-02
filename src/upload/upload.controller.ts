import { Controller, Post, UseInterceptors, UploadedFile, Body, Req } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UploadDto } from './dto/upload.dto';

@ApiTags('Upload')
@Controller('upload')
export class UploadController {
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

    console.log('upload file info:', file);
    // 这里我们只是演示拦截器的使用，并没有真实的保存文件到云端或磁盘
    // 在实际项目中，这里会调用 Service 将 file 保存，并返回 URL
    return {
      message: '文件流解析成功',
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      dtoName: uploadDto.name, // 验证 DTO 数据也能被解析
    };
  }
}

