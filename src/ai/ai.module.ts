import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { LcelController } from './lcel.controller';
import { LcelService } from './lcel.service';
import { ToolRegistry } from './tools/tool.registry';
import { ToolCallingLoop } from './tools/tool-calling.loop';
import { AiModelFactory } from './factories/model.factory';
import { ReasoningNormalizer } from './normalizers/reasoning.normalizer';
import { AgentRegistry } from './agents/agent.registry';
import { AiStreamAdapter } from './adapters/stream.adapter';
import { ChatChainBuilder } from './chains';
import { SchemaRegistry } from './schemas';
import { ChatHistoryFactory, SessionManagerService } from './memory';
import {
  EmbeddingsFactory,
  VectorStoreService,
  DocumentProcessor,
} from './rag';

/**
 * AI 模块
 *
 * 负责集成各类 AI 能力，包括：
 * 1. 多模型厂商适配 (DeepSeek, Qwen, Moonshot, GLM)
 * 2. 对话与推理服务 (Chat & Reasoning)
 * 3. 推理字段归一化 (Reasoning Normalization)
 * 4. 智能体与工具调用 (Agents & Tools，后续章节)
 *
 * 041 新增 LCEL 抽象层：
 * - LcelController & LcelService: 独立的 LCEL 管道端点与服务（与过程式隔离）
 * - ChatChainBuilder:             LCEL 链构建器（组装 prompt → model 管道）
 *
 * 042 新增结构化输出层：
 * - SchemaRegistry:  Zod Schema 注册表（管理可用于 withStructuredOutput 的预定义 Schema）
 *
 * 043 新增工具调用层：
 * - ToolCallingLoop:  Agentic 工具调用循环引擎（bindTools → invoke → 执行工具 → 再推理）
 * - ToolRegistry 重构: 从自定义 IAiTool 迁移到 LangChain 原生 StructuredTool
 * - 内置工具:         get_current_time / calculate / get_weather
 *
 * 044 新增有状态会话层：
 * - ChatHistoryFactory:    对话历史工厂（按 sessionId 创建 Redis 存储实例）
 * - SessionManagerService: 会话管理服务（查询、删除、列出会话）
 * - RedisChatHistory:      自行实现的 BaseChatMessageHistory（复用 ioredis，零新依赖）
 * - WindowedChatHistory:   滑动窗口装饰器（控制模型上下文长度）
 *
 * 045 新增 RAG 检索增强生成层：
 * - EmbeddingsFactory:     Embedding 模型工厂（OpenAIEmbeddings + SiliconFlow 兼容）
 * - VectorStoreService:    向量存储服务（管理 PgVectorStore 生命周期）
 * - DocumentProcessor:     文档切块处理器（RecursiveCharacterTextSplitter）
 * - PgVectorStore:          自行实现的 VectorStore（复用 pg，零新集成包依赖）
 *
 * 核心依赖:
 * - AiModelFactory:       模型实例化工厂（生产 LangChain BaseChatModel）
 * - ReasoningNormalizer:   推理字段归一化（屏蔽厂商差异）
 * - ToolRegistry:          工具注册表（管理可供 AI 调用的工具）
 * - AgentRegistry:         智能体注册表（集中管理所有 Agent 实例）
 */
@Module({
  imports: [ConfigModule],
  controllers: [AiController, LcelController],
  providers: [
    AiService,
    LcelService,
    AiModelFactory,
    ReasoningNormalizer,
    ToolRegistry,
    ToolCallingLoop,
    AgentRegistry,
    AiStreamAdapter,
    ChatChainBuilder,
    SchemaRegistry,
    ChatHistoryFactory,
    SessionManagerService,
    EmbeddingsFactory,
    VectorStoreService,
    DocumentProcessor,
  ],
  exports: [
    AiService,
    LcelService,
    ReasoningNormalizer,
    ToolRegistry,
    ToolCallingLoop,
    AgentRegistry,
    ChatChainBuilder,
    SchemaRegistry,
    ChatHistoryFactory,
    SessionManagerService,
    EmbeddingsFactory,
    VectorStoreService,
    DocumentProcessor,
  ],
})
export class AiModule {}
