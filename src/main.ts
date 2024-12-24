import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './config/swagger.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // 初始化 Swagger 文档
  setupSwagger(app);
  
  await app.listen(process.env.PORT ?? 8000);
}
bootstrap();
