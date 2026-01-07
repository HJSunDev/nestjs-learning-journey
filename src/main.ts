import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import helmet from 'helmet';
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

  // 如果应用运行在 Nginx/负载均衡之后，必须开启此配置，否则 RateLimit 获取到的 IP 永远是 127.0.0.1
  // app.set('trust proxy', 1);

  // 2. 获取 Winston 实例并替换全局 Logger
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  // 3. 配置 HTTP 安全头 (Helmet)
  // 生产环境建议开启 contentSecurityPolicy，但需兼容 Swagger UI 的 inline script/style
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Swagger UI 依赖
          styleSrc: ["'self'", "'unsafe-inline'"], // Swagger UI 依赖
          imgSrc: ["'self'", 'data:', 'validator.swagger.io'], // Swagger Validator 图标
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

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

  // 注册全局序列化拦截器 (ClassSerializerInterceptor)
  // 这将自动应用 @Exclude(), @Expose() 等装饰器规则，处理敏感信息
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

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
