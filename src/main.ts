import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { setupSwagger } from './common/configs/setup-swagger';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 注册全局异常过滤器
  app.useGlobalFilters(new HttpExceptionFilter());

  // 开启全局参数校验管道
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, // 自动剔除 DTO 中未定义的属性 (防止恶意字段注入)
    transform: true, // 自动转换参数类型 (如将 ID 字符串转为数字)
  }));

  // 集成 Swagger 文档
  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
