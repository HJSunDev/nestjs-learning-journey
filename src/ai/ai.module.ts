import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ToolRegistry } from './tools/tool.registry';
import { AiModelFactory } from './factories/model.factory';
import { ReasoningNormalizer } from './normalizers/reasoning.normalizer';
import { AgentRegistry } from './agents/agent.registry';

/**
 * AI 模块
 *
 * 负责集成各类 AI 能力，包括：
 * 1. 多模型厂商适配 (DeepSeek, Qwen, Moonshot, GLM)
 * 2. 对话与推理服务 (Chat & Reasoning)
 * 3. 推理字段归一化 (Reasoning Normalization)
 * 4. 智能体与工具调用 (Agents & Tools，后续章节)
 *
 * 核心依赖:
 * - AiModelFactory:       模型实例化工厂（生产 LangChain BaseChatModel）
 * - ReasoningNormalizer:   推理字段归一化（屏蔽厂商差异）
 * - ToolRegistry:          工具注册表（管理可供 AI 调用的工具）
 * - AgentRegistry:         智能体注册表（集中管理所有 Agent 实例）
 */
@Module({
  imports: [ConfigModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiModelFactory,
    ReasoningNormalizer,
    ToolRegistry,
    AgentRegistry,
  ],
  exports: [AiService, ReasoningNormalizer, ToolRegistry, AgentRegistry],
})
export class AiModule {}
