import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { AppConfigModule } from './common/configs/app-config.module';

@Module({
  imports: [
    AppConfigModule, // 全局配置模块，一旦导入，所有其他模块都能直接用 ConfigService
    UserModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
