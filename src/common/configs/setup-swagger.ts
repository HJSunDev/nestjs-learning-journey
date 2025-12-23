import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import * as packageJson from '../../../package.json';

/**
 * 配置并启动 Swagger 文档
 * @param app Nest 应用实例
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle(packageJson.name)
    .setDescription(packageJson.description)
    .setVersion(packageJson.version)
    .addBearerAuth() // 允许使用 Bearer Token 认证
    .build();

  const document = SwaggerModule.createDocument(app, config);
  
  // 设置 Swagger UI 的访问路径，这里设置为 /api/docs
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true, // 刷新页面后保留 token
    },
  });
}

