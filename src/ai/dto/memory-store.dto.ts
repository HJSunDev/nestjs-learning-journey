import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  IsEnum,
  ValidateNested,
  ArrayMinSize,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AiProvider, MessageRole } from '../constants';

// ============================================================
// Memory Agent DTO
// ============================================================

class MemoryAgentMessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '请帮我查一下今天的天气',
  })
  @IsString()
  content: string;
}

/**
 * Memory-aware Agent 对话请求 DTO
 *
 * @example
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   userId: 'user-123',
 *   messages: [{ role: 'user', content: '你好，记住我喜欢暗色主题' }],
 *   enableMemoryExtraction: true,
 *   enableSkillLoading: false
 * }
 */
export class MemoryAgentChatRequestDto {
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

  @ApiProperty({
    description: '用户标识（记忆命名空间隔离的依据）',
    example: 'user-123',
  })
  @IsString()
  userId: string;

  @ApiProperty({
    description: '消息列表',
    type: [MemoryAgentMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MemoryAgentMessageDto)
  messages: MemoryAgentMessageDto[];

  @ApiPropertyOptional({
    description: '系统提示词（基础角色指令）',
    example: '你是一个能记住用户偏好的智能助手。',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description: '线程 ID（用于 checkpoint 持久化和 Lane Queue 串行化）',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsOptional()
  threadId?: string;

  @ApiPropertyOptional({
    description: '启用的工具名称列表',
    type: [String],
    example: ['get_current_time', 'get_weather'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tools?: string[];

  @ApiPropertyOptional({
    description: '最大迭代次数',
    default: 5,
    minimum: 1,
    maximum: 10,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(10)
  maxIterations?: number;

  @ApiPropertyOptional({
    description: '温度参数 (0-2)',
    default: 0.7,
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
    description: '是否启用记忆提取（模型自动从回复中提取并存储记忆）',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  enableMemoryExtraction?: boolean;

  @ApiPropertyOptional({
    description: '是否启用技能加载（根据对话上下文动态搜索并注入技能指令）',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  enableSkillLoading?: boolean;
}

/**
 * Memory-aware Agent 对话响应 DTO
 */
export class MemoryAgentChatResponseDto {
  @ApiProperty({ description: 'AI 回复内容' })
  content: string;

  @ApiProperty({
    description: '本次检索并注入的记忆条数',
    example: 3,
  })
  memoriesLoaded: number;

  @ApiProperty({
    description: '本次加载的技能条数',
    example: 0,
  })
  skillsLoaded: number;

  @ApiProperty({
    description: '本次从回复中提取并存储的新记忆条数',
    example: 1,
  })
  memoriesStored: number;

  @ApiPropertyOptional({ description: 'Token 使用统计' })
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  @ApiPropertyOptional({ description: '链路追踪摘要' })
  trace?: {
    traceId: string;
    totalLatencyMs: number;
    llmCallCount: number;
    totalTokens: number;
  };
}

// ============================================================
// Memory Store 管理 DTO
// ============================================================

/**
 * 记忆类型枚举（DTO 层镜像）
 */
export enum MemoryTypeDto {
  SEMANTIC = 'semantic',
  EPISODIC = 'episodic',
  PROCEDURAL = 'procedural',
}

/**
 * 创建/更新记忆请求 DTO
 *
 * @example
 * {
 *   type: 'semantic',
 *   content: '用户偏好暗色主题和 Vim 快捷键',
 *   metadata: { confidence: 0.9 }
 * }
 */
export class PutMemoryRequestDto {
  @ApiProperty({
    description: '记忆类型',
    enum: MemoryTypeDto,
    example: MemoryTypeDto.SEMANTIC,
  })
  @IsEnum(MemoryTypeDto)
  type: MemoryTypeDto;

  @ApiProperty({
    description: '记忆内容',
    example: '用户偏好暗色主题和 Vim 快捷键',
  })
  @IsString()
  content: string;

  @ApiPropertyOptional({
    description: '自定义元数据',
    example: { confidence: 0.9, source: 'conversation' },
  })
  @IsOptional()
  metadata?: Record<string, unknown>;
}

/**
 * 搜索记忆请求 DTO（Query 参数）
 */
export class SearchMemoriesQueryDto {
  @ApiProperty({
    description: '搜索查询（自然语言）',
    example: '用户偏好什么主题？',
  })
  @IsString()
  query: string;

  @ApiPropertyOptional({
    description: '按记忆类型筛选',
    enum: MemoryTypeDto,
  })
  @IsEnum(MemoryTypeDto)
  @IsOptional()
  type?: MemoryTypeDto;

  @ApiPropertyOptional({
    description: '返回条数',
    default: 5,
  })
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(20)
  limit?: number;
}

// ============================================================
// Skills（文件系统）响应 DTO
// ============================================================

/**
 * 技能目录条目（列表响应用）
 */
export class SkillCatalogEntryDto {
  @ApiProperty({ description: '技能名称', example: 'code-review' })
  name: string;

  @ApiProperty({
    description: '技能描述',
    example: '代码审查专家技能',
  })
  description: string;

  @ApiProperty({
    description: '分类标签',
    type: [String],
    example: ['code', 'review'],
  })
  tags: string[];

  @ApiProperty({
    description: '辅助资源文件列表',
    type: [String],
    example: ['references/checklist.md'],
  })
  supportingFiles: string[];
}

/**
 * 技能详情响应 DTO
 */
export class SkillDetailResponseDto {
  @ApiProperty({ description: '技能名称' })
  name: string;

  @ApiProperty({ description: '技能描述' })
  description: string;

  @ApiProperty({ description: '分类标签', type: [String] })
  tags: string[];

  @ApiProperty({
    description: '技能指令内容（Markdown）',
    example: '## Code Review Guidelines\n...',
  })
  content: string;

  @ApiProperty({
    description: '辅助资源文件列表',
    type: [String],
  })
  supportingFiles: string[];
}
