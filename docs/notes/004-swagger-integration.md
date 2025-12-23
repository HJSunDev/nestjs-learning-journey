# 004. Swagger 接口文档集成

## 1. 背景与需求 (Context & Requirements)
- **场景**: 前后端分离开发中，前端需要清晰的接口定义（URL、参数、返回结构）才能开发，手动维护 Word 或 Markdown 文档效率低且容易与代码脱节。
- **目标**: 自动根据代码生成在线接口文档，支持直接在网页上进行接口测试（Try it out）。
- **核心概念**: **OpenAPI (Swagger)** - 一种描述 REST API 的标准规范。

## 2. 核心用法 / 方案设计 (Usage / Design)

### 2.1 模块化配置 (Configuration)
不建议将大量配置写在 `main.ts`。最佳实践是抽离为独立函数，保持入口文件整洁。通过读取 `package.json` 保持文档版本与项目版本同步。

### 2.2 装饰器核心体系 (Decorators)
Swagger 通过装饰器收集元数据：

*   **控制器层**: `@ApiTags` (分组), `@ApiOperation` (接口描述), `@ApiResponse` (响应定义)
*   **DTO 层**: `@ApiProperty` (字段描述、示例值)

### 2.3 关键概念：DTO 的继承陷阱 (The PartialType Trap)
**问题**: 为什么 `UpdateUserDto` 要用 `@nestjs/swagger` 的 `PartialType`？

*   **❌ @nestjs/mapped-types**: 仅将 TypeScript 类型变为可选。Swagger **无法感知** 父类 `CreateUserDto` 上的 `@ApiProperty` 装饰器，导致文档中更新接口没有参数描述。
*   **✅ @nestjs/swagger**: 继承类型的同时，**自动拷贝并应用** 父类的 Swagger 元数据，同时将字段在文档中标记为 `required: false`。

## 3. 最佳实践
- ✅ **单源真理 (Single Source of Truth)**: 让代码（DTO）成为文档的唯一来源，不要手写文档。
- ✅ **同步元数据**: 使用 `package.json` 的信息配置 Swagger Title/Version，避免硬编码。
- ✅ **独立配置**: 使用 `setupSwagger` 函数保持 `main.ts` 简洁。

## 4. 行动导向 (Implementation Steps)

### Step 1: 安装依赖
```bash
npm install @nestjs/swagger swagger-ui-express
```

### Step 2: 允许 JSON 导入 (tsconfig.json)
为了在代码中读取 `package.json` 的版本号，需开启 `resolveJsonModule`。
```json
// tsconfig.json
{
  "compilerOptions": {
    "resolveJsonModule": true, 
    // ... 其他配置
  }
}
```

### Step 3: 创建配置脚本
新建 `src/common/configs/setup-swagger.ts`，实现文档构建逻辑：

```typescript
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as packageJson from '../../../package.json';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle(packageJson.name)
    .setDescription(packageJson.description)
    .setVersion(packageJson.version)
    .addBearerAuth() 
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
}
```

### Step 4: 在主入口注册
修改 `src/main.ts`，调用配置函数：

```typescript
import { setupSwagger } from './common/configs/setup-swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // 注册 Swagger
  setupSwagger(app);
  
  await app.listen(process.env.PORT ?? 3000);
}
```

### Step 5: 改造 DTO (关键)
**1. 为 Create DTO 添加描述**
修改 `src/user/dto/create-user.dto.ts`，使用 `@ApiProperty`：
```typescript
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ description: '用户邮箱', example: 'user@example.com' })
  email: string;
  // ... 其他字段
}
```

**2. 替换 Update DTO 的继承源**
修改 `src/user/dto/update-user.dto.ts`，**注意 import 来源的变化**：

```typescript
// ❌ 移除旧导入
// import { PartialType } from '@nestjs/mapped-types';

// ✅ 使用 Swagger 版导入，以继承文档元数据
import { PartialType } from '@nestjs/swagger'; 
import { CreateUserDto } from './create-user.dto';

export class UpdateUserDto extends PartialType(CreateUserDto) {}
```

### Step 6: 启动与验证
运行 `npm run start:dev`，访问 `http://localhost:3000/api/docs`，确认：
1. 文档页面正常加载。
2. POST /users 接口中，Request Body 有详细字段说明。
3. PATCH /users/{id} 接口中，Request Body 字段可见且标记为 Optional。
