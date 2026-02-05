import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ToolRegistry } from './tools/tool.registry';
import { AiModelFactory } from './factories/model.factory';

/**
 * AI 模块
 *
 * 负责集成各类 AI 能力，包括：
 * 1. 多模型厂商适配 (DeepSeek, Qwen, Moonshot, GLM)
 * 2. 对话与推理服务 (Chat & Reasoning)
 * 3. 智能体与工具调用 (Agents & Tools)
 *
 * 依赖说明：
 * - 核心依赖: LangChain / LangGraph (构建中)
 * - 基础设施: AiModelFactory (模型工厂), ToolRegistry (工具注册)
 */
@Module({
  imports: [ConfigModule],
  controllers: [AiController],
  providers: [
    AiService,
    ToolRegistry,
    AiModelFactory, // 注册模型工厂服务
  ],
  exports: [AiService, ToolRegistry],
})
export class AiModule {}
