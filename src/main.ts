import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './common/configs/setup-swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 集成 Swagger 文档
  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
