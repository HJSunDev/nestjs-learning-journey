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
import { AgentController } from './agents/agent.controller';
import { GraphService } from './agents/graph.service';
import { ReactService } from './agents/react.service';
import { CheckpointService, ThreadService } from './agents/persistence';
import { HitlService } from './agents/hitl';
import { AdvancedPatternsService } from './agents/advanced-patterns';
import { AiStreamAdapter } from './adapters/stream.adapter';
import { ChatChainBuilder } from './chains';
import { SchemaRegistry } from './schemas';
import { ChatHistoryFactory, SessionManagerService } from './memory';
import {
  EmbeddingsFactory,
  VectorStoreService,
  DocumentProcessor,
} from './rag';
import { ResilienceService } from './resilience';

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
 * 046 新增可观测性与韧性层：
 * - LangChainTracer:       BaseCallbackHandler 实现（per-request 链路追踪，非 DI 注入）
 * - ResilienceService:     韧性包装服务（.withRetry() 重试 + .withFallbacks() 降级）
 *
 * 047 新增 LangGraph StateGraph 层：
 * - AgentController:       独立的 Agent HTTP 入口（路由前缀 /ai/agent，与 LCEL 完全隔离）
 * - GraphService:          NestJS 与 LangGraph 的桥接层（管理编译后的 StateGraph）
 * - AgentState:            共享 State 定义（StateSchema + MessagesValue + ReducedValue）
 * - callModelNode / executeToolsNode / shouldContinue: 共享图节点和条件路由
 * - buildToolGraph:        Graph API 版工具调用图构建器
 *
 * 048 新增 ReAct Agent 层：
 * - ReactService:          ReAct 智能体服务（双模式：自建图 + createReactAgent 预构建）
 * - ReAct 提示词:          引导 Thought → Action → Observation 循环的系统提示词
 * - 输入安全守卫:          Prompt Injection 检测 + 消息长度/数量限制
 * - buildPrebuiltReactAgent: createReactAgent 预构建封装
 *
 * 049 新增 Durable Execution 持久化层：
 * - CheckpointService:     PostgresSaver 生命周期管理（初始化表结构、提供 checkpointer 实例）
 * - ThreadService:          线程状态查询、checkpoint 历史回溯、Time-travel 分叉
 * - ReactService 扩展:     invokeWithThread/streamWithThread 线程感知的持久化执行
 *
 * 050 新增 Human-in-the-Loop 人机协同层：
 * - HitlService:            HITL 智能体服务（interrupt/resume 审批生命周期管理）
 * - buildHitlToolGraph:     HITL 图构建器（含 reviewToolCalls 审批中断节点）
 * - reviewToolCallsNode:    审批节点（interrupt() 暂停 + Command 动态路由）
 *
 * 051 新增高级 Agent 模式层：
 * - AdvancedPatternsService: Reflection 自我修正 + Plan-Execute 规划执行
 * - buildReflectionGraph:    Reflection 图构建器（generate → evaluate → shouldReflect 循环）
 * - buildPlanExecuteGraph:   Plan-Execute 图构建器（planner → executor → replanner，含 Subgraph 组合）
 *
 * 核心依赖:
 * - AiModelFactory:       模型实例化工厂（生产 LangChain BaseChatModel）
 * - ReasoningNormalizer:   推理字段归一化（屏蔽厂商差异）
 * - ToolRegistry:          工具注册表（管理可供 AI 调用的工具）
 * - AgentRegistry:         智能体注册表（集中管理所有 Agent 实例）
 */
@Module({
  imports: [ConfigModule],
  controllers: [AiController, LcelController, AgentController],
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
    ResilienceService,
    GraphService,
    ReactService,
    CheckpointService,
    ThreadService,
    HitlService,
    AdvancedPatternsService,
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
    ResilienceService,
    GraphService,
    ReactService,
    CheckpointService,
    ThreadService,
    HitlService,
    AdvancedPatternsService,
  ],
})
export class AiModule {}
