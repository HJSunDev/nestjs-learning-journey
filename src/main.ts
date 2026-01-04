import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AppModule } from './app.module';
import { setupSwagger } from './common/configs/setup-swagger';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { resolve } from 'path';

async function bootstrap() {
  // 1. 创建应用实例，开启 bufferLogs 以便完全接管启动日志
  // 使用 NestExpressApplication 泛型，来支持 Express 类型HTTP 适配器特有的方法代码提示 以及 类型推导
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // 2. 获取 Winston 实例并替换全局 Logger
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  // 获取 ConfigService 实例
  const configService = app.get(ConfigService);

  // 配置静态资源服务 (图床)
  // 1. 获取配置的路径，默认为 'static/upload'
  const configUploadDir =
    configService.get<string>('upload.dir') || 'static/upload';

  // 2. 解析为绝对路径 (支持相对路径和绝对路径的自动归一化)
  const uploadDir = resolve(process.cwd(), configUploadDir);

  app.useStaticAssets(uploadDir, {
    prefix: '/static/upload', // 虚拟路径前缀，访问时 http://localhost:3000/static/upload/xxx.jpg
  });

  // 注册全局异常过滤器
  app.useGlobalFilters(new HttpExceptionFilter());

  // 开启全局参数校验管道
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, // 自动剔除 DTO 中未定义的属性 (防止恶意字段注入)
    transform: true, // 自动转换参数类型 (如将 ID 字符串转为数字)
  }));

  // 集成 Swagger 文档
  setupSwagger(app);

  const port = configService.get<number>('port') ?? 3000;
  await app.listen(port);
}
bootstrap();
