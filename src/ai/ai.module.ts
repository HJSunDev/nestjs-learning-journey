import { Module } from '@nestjs/common';

import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ToolRegistry } from './tools';

/**
 * AI 服务模块
 *
 * 提供 AI 对话、流式响应、工具调用等能力
 *
 * 功能特性：
 * - 多 Provider 支持（DeepSeek、Qwen、GLM、MiniMax、OpenAI、Claude、Gemini）
 * - 流式 SSE 响应
 * - 推理过程获取
 * - 工具调用（预留）
 * - 多智能体协作（预留）
 *
 * 使用方式：
 * 1. 在 AppModule 中导入此模块
 * 2. 配置 .env 中的 API Key
 * 3. 通过 /ai/* 端点访问 AI 服务
 */
@Module({
  controllers: [AiController],
  providers: [AiService, ToolRegistry],
  exports: [AiService, ToolRegistry],
})
export class AiModule {}
