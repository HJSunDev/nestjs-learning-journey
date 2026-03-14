import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsArray,
  Min,
  Max,
  MinLength,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AiProvider } from '../constants';

// ============================================================
// 文档摄入 (Ingest)
// ============================================================

/**
 * 文档摄入条目
 *
 * 单个文档的文本和元数据，用于批量摄入。
 */
export class IngestDocumentItemDto {
  @ApiProperty({
    description: '文档文本内容',
    example: 'NestJS 是一个用于构建高效、可扩展的 Node.js 服务端应用的框架。',
  })
  @IsString()
  @MinLength(1)
  text: string;

  @ApiPropertyOptional({
    description: '文档元数据（如来源、标题等）',
    example: { source: 'docs/nestjs-intro.md', title: 'NestJS 简介' },
  })
  @IsOptional()
  metadata?: Record<string, unknown>;
}

/**
 * 文档摄入请求 DTO
 *
 * 将文本文档切块、向量化后存入向量数据库。
 */
export class IngestDocumentsRequestDto {
  @ApiProperty({
    description: '要摄入的文档列表',
    type: [IngestDocumentItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => IngestDocumentItemDto)
  documents: IngestDocumentItemDto[];

  @ApiPropertyOptional({
    description: '知识库集合名称（用于隔离不同知识库）',
    default: 'default',
    example: 'nestjs-docs',
  })
  @IsString()
  @IsOptional()
  collection?: string;

  @ApiPropertyOptional({
    description: '文档切块大小（字符数），覆盖默认配置',
    default: 500,
  })
  @IsNumber()
  @IsOptional()
  @Min(100)
  @Max(10000)
  chunkSize?: number;

  @ApiPropertyOptional({
    description: '切块重叠区域（字符数），覆盖默认配置',
    default: 50,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  chunkOverlap?: number;
}

/**
 * 文档摄入响应 DTO
 */
export class IngestDocumentsResponseDto {
  @ApiProperty({ description: '摄入的文档块 ID 列表' })
  documentIds: string[];

  @ApiProperty({ description: '生成的文档块总数' })
  chunkCount: number;

  @ApiProperty({ description: '目标集合名称' })
  collection: string;

  @ApiProperty({ description: '操作描述' })
  message: string;
}

// ============================================================
// RAG 对话 (Chat)
// ============================================================

/**
 * RAG 对话请求 DTO
 *
 * 与 QuickChatRequestDto 的核心差异：
 * - 先从向量数据库检索相关文档，再将文档内容作为上下文注入 prompt
 * - 支持通过 collection 和 topK 控制检索范围和精度
 */
export class RagChatRequestDto {
  @ApiProperty({
    description: '用户查询文本',
    example: 'NestJS 中如何实现依赖注入？',
  })
  @IsString()
  @MinLength(1)
  question: string;

  @ApiProperty({
    description: 'AI 提供商',
    enum: AiProvider,
    default: AiProvider.SILICONFLOW,
    example: AiProvider.SILICONFLOW,
  })
  @IsEnum(AiProvider)
  provider: AiProvider = AiProvider.SILICONFLOW;

  @ApiProperty({
    description: '模型名称',
    default: 'Pro/MiniMaxAI/MiniMax-M2.5',
    example: 'Pro/MiniMaxAI/MiniMax-M2.5',
  })
  @IsString()
  model: string = 'Pro/MiniMaxAI/MiniMax-M2.5';

  @ApiPropertyOptional({
    description: '知识库集合名称（限定检索范围）',
    default: 'default',
    example: 'nestjs-docs',
  })
  @IsString()
  @IsOptional()
  collection?: string;

  @ApiPropertyOptional({
    description: '检索返回的相关文档数量',
    default: 4,
    minimum: 1,
    maximum: 20,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(20)
  topK?: number;

  @ApiPropertyOptional({
    description: '额外的系统指令（追加到 RAG 指令之后）',
    example: '请用简洁的技术语言回答',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description: '温度参数 (0-2)，值越高回复越随机',
    default: 0.7,
    minimum: 0,
    maximum: 2,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({
    description: '最大输出 Token 数',
    default: 4096,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  maxTokens?: number;

  @ApiPropertyOptional({
    description: '是否启用推理模式（获取思考过程）',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  enableReasoning?: boolean;
}

/**
 * 检索到的来源文档信息
 */
export class RetrievedSourceDto {
  @ApiProperty({ description: '文档内容片段' })
  content: string;

  @ApiProperty({ description: '相似度分数（越小越相似）' })
  score: number;

  @ApiPropertyOptional({ description: '文档元数据' })
  metadata?: Record<string, unknown>;
}

/**
 * retrieveContext 函数的返回值结构
 *
 * @property sources - 结构化的来源信息数组，用于 API 响应
 * @property context - 序列化的上下文文本，用于注入 LLM prompt
 *
 * @example
 * // sources 结构（用于返回给客户端）
 * [
 *   { content: "文档内容...", score: 0.15, metadata: { source: "doc.md" } }
 * ]
 *
 * @example
 * // context 结构（用于注入 prompt）
 * `[来源 1] (doc.md)
 * 文档内容...
 *
 * [来源 2] (other.md)
 * 其他文档内容...`
 */
export interface RetrieveContextResult {
  /** 结构化的来源信息数组，直接用于 API 响应 */
  sources: RetrievedSourceDto[];
  /** 序列化的上下文文本，格式化为 [来源 N] (文件名)\n内容 的形式 */
  context: string;
}

/**
 * RAG 对话响应 DTO
 */
export class RagChatResponseDto {
  @ApiProperty({ description: 'AI 回复内容' })
  content: string;

  @ApiProperty({
    description: '检索到的来源文档',
    type: [RetrievedSourceDto],
  })
  sources: RetrievedSourceDto[];

  @ApiPropertyOptional({ description: '推理过程（仅推理模式）' })
  reasoning?: string;

  @ApiPropertyOptional({ description: 'Token 使用统计' })
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  @ApiPropertyOptional({ description: '完成原因', example: 'stop' })
  finishReason?: string;
}

// ============================================================
// 相似度搜索 (Search)
// ============================================================

/**
 * 相似度搜索请求 DTO
 *
 * 直接对向量数据库进行相似度检索，不经过 LLM 生成。
 * 用于调试检索质量、浏览知识库内容。
 */
export class SimilaritySearchRequestDto {
  @ApiProperty({
    description: '搜索查询文本',
    example: '依赖注入',
  })
  @IsString()
  @MinLength(1)
  query: string;

  @ApiPropertyOptional({
    description: '返回的文档数量',
    default: 4,
    minimum: 1,
    maximum: 20,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(20)
  topK?: number;

  @ApiPropertyOptional({
    description: '知识库集合名称',
    default: 'default',
  })
  @IsString()
  @IsOptional()
  collection?: string;
}

/**
 * 相似度搜索响应 DTO
 */
export class SimilaritySearchResponseDto {
  @ApiProperty({
    description: '检索结果',
    type: [RetrievedSourceDto],
  })
  results: RetrievedSourceDto[];

  @ApiProperty({ description: '结果总数' })
  total: number;
}

// ============================================================
// 集合管理 (Collections)
// ============================================================

/**
 * 集合列表响应 DTO
 */
export class CollectionListResponseDto {
  @ApiProperty({
    description: '集合列表',
  })
  collections: {
    collection: string;
    documentCount: number;
  }[];

  @ApiProperty({ description: '集合总数' })
  total: number;
}

/**
 * 删除集合响应 DTO
 */
export class DeleteCollectionResponseDto {
  @ApiProperty({ description: '被删除的集合名称' })
  collection: string;

  @ApiProperty({ description: '被删除的文档数量' })
  deletedDocumentCount: number;

  @ApiProperty({ description: '操作描述' })
  message: string;
}
