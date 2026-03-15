import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  IsEnum,
  ValidateNested,
  Min,
  Max,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Exclude, Expose } from 'class-transformer';
import { AiProvider } from '../constants';
import { MessageDto } from './chat-request.dto';

/**
 * 降级模型配置 DTO
 */
export class FallbackModelDto {
  @ApiProperty({
    description: '备用模型的提供商',
    enum: AiProvider,
    example: AiProvider.SILICONFLOW,
  })
  @IsEnum(AiProvider)
  provider: AiProvider;

  @ApiPropertyOptional({
    description: '备用模型 ID（不指定则使用该提供商的默认模型）',
    example: 'Pro/MiniMaxAI/MiniMax-M2.5',
  })
  @IsString()
  @IsOptional()
  model?: string;
}

/**
 * 韧性对话请求 DTO
 *
 * 在标准对话请求的基础上，增加重试和降级配置。
 */
export class ResilientChatRequestDto {
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
    description: '消息列表（支持多轮对话）',
    type: [MessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MessageDto)
  messages: MessageDto[];

  @ApiPropertyOptional({
    description: '系统提示词',
    example: '你是一个专业的技术顾问',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

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
    description: '是否启用推理模式',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  enableReasoning?: boolean;

  // --- 韧性配置 ---

  @ApiPropertyOptional({
    description: '是否启用重试（默认启用，重试 2 次）',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  enableRetry?: boolean;

  @ApiPropertyOptional({
    description: '最大重试次数（不含首次调用）',
    default: 2,
    minimum: 1,
    maximum: 5,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(5)
  maxRetryAttempts?: number;

  @ApiPropertyOptional({
    description: '降级模型列表（按优先级排序，主模型失败后依次尝试）',
    type: [FallbackModelDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FallbackModelDto)
  @IsOptional()
  fallbacks?: FallbackModelDto[];
}

/**
 * 追踪摘要 DTO
 *
 * 从 LangChainTracer 的 TraceSummary 提取的关键可观测性指标，
 * 随响应返回给调用方。
 */
@Exclude()
export class TraceInfoDto {
  @ApiProperty({ description: '追踪 ID' })
  @Expose()
  traceId: string;

  @ApiProperty({ description: '请求总耗时 (ms)' })
  @Expose()
  totalLatencyMs: number;

  @ApiProperty({ description: 'LLM 调用次数' })
  @Expose()
  llmCallCount: number;

  @ApiProperty({ description: 'LLM 调用总耗时 (ms)' })
  @Expose()
  llmTotalLatencyMs: number;

  @ApiProperty({ description: '总 Token 用量' })
  @Expose()
  totalTokens: number;

  @ApiPropertyOptional({ description: '工具调用次数' })
  @Expose()
  toolCallCount?: number;

  @ApiPropertyOptional({ description: '检索操作次数' })
  @Expose()
  retrieverCallCount?: number;

  @ApiPropertyOptional({ description: '是否触发了重试' })
  @Expose()
  retryTriggered?: boolean;

  @ApiPropertyOptional({ description: '是否触发了降级' })
  @Expose()
  fallbackTriggered?: boolean;
}

/**
 * 韧性对话响应 DTO
 *
 * 在标准对话响应基础上，增加追踪摘要信息。
 */
@Exclude()
export class ResilientChatResponseDto {
  @ApiProperty({
    description: '响应内容',
    example: '依赖注入是一种设计模式...',
  })
  @Expose()
  content: string;

  @ApiPropertyOptional({
    description: '推理/思考过程（仅推理模型返回）',
  })
  @Expose()
  reasoning?: string;

  @ApiPropertyOptional({
    description: 'Token 使用统计',
  })
  @Expose()
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  @ApiPropertyOptional({
    description: '完成原因',
    example: 'stop',
  })
  @Expose()
  finishReason?: string;

  @ApiProperty({
    description: '追踪摘要信息',
    type: TraceInfoDto,
  })
  @Expose()
  trace: TraceInfoDto;
}
