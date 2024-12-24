import { DocumentBuilder, SwaggerCustomOptions, SwaggerModule } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';
import { name, version, description } from '../../package.json';

// Swagger API 文档构建器配置
const swaggerConfig = new DocumentBuilder()
  // 设置 Swagger UI 页面的主标题，显示在文档内容区顶部
  .setTitle(name)
  .setDescription(description || `${name} API 接口文档`)
  .setVersion(version)
  // 添加 Bearer 认证支持，用于 API 请求的身份验证
  .addBearerAuth()
  .build();

// Swagger UI 界面配置选项
const swaggerOptions: SwaggerCustomOptions = {
  // 配置 Swagger 文档的持久化授权
  swaggerOptions: {
    persistAuthorization: true,
  },
  // 设置浏览器标签页（Tab）显示的标题
  customSiteTitle: `${name} API Docs`,
}

// 初始化 Swagger 文档
export const setupSwagger = (app: INestApplication) => {
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, swaggerOptions);
} 