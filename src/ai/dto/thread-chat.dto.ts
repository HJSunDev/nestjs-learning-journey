import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsEnum,
  IsUUID,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AiProvider, MessageRole } from '../constants';

/**
 * 持久化模式枚举
 */
export enum DurabilityMode {
  SYNC = 'sync',
  ASYNC = 'async',
  EXIT = 'exit',
}

/**
 * Thread 消息 DTO
 */
export class ThreadMessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '帮我查一下北京现在的天气',
  })
  @IsString()
  content: string;
}

/**
 * 线程感知的 ReAct Agent 对话请求 DTO（049 Durable Execution）
 *
 * 与 ReactChatRequestDto 的核心差异：
 * - threadId：指定线程 ID，同一线程的后续调用延续之前的状态
 * - durability：持久化模式（sync/async/exit）
 * - messages 可选：为空时表示恢复执行（从最后一个成功的 checkpoint 继续）
 *
 * @example
 * // 首次对话（新建线程）
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   messages: [{ role: 'user', content: '北京天气怎么样？' }],
 *   threadId: '550e8400-e29b-41d4-a716-446655440000'
 * }
 *
 * @example
 * // 恢复执行（从上次中断点继续）
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   threadId: '550e8400-e29b-41d4-a716-446655440000'
 * }
 */
export class ThreadChatRequestDto {
  @ApiProperty({
    description: 'AI 提供商',
    enum: AiProvider,
    default: AiProvider.SILICONFLOW,
    example: AiProvider.SILICONFLOW,
  })
  @IsEnum(AiProvider)
  provider: AiProvider = AiProvider.SILICONFLOW;

  @ApiProperty({
    description: '模型名称（必须支持 tool calling）',
    default: 'Pro/MiniMaxAI/MiniMax-M2.5',
    example: 'Pro/MiniMaxAI/MiniMax-M2.5',
  })
  @IsString()
  model: string = 'Pro/MiniMaxAI/MiniMax-M2.5';

  @ApiProperty({
    description:
      '线程 ID（UUID v4），同一 ID 的后续调用延续已有的执行状态。' +
      '首次对话时由客户端生成，后续对话复用同一 ID。',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4')
  threadId: string;

  @ApiPropertyOptional({
    description:
      '消息列表。为空或不传时表示恢复执行（从最后一个成功的 checkpoint 继续）。',
    type: [ThreadMessageDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ThreadMessageDto)
  @IsOptional()
  messages?: ThreadMessageDto[];

  @ApiPropertyOptional({
    description: '自定义系统提示词。不提供时使用内置 ReAct 提示词。',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description: '启用的工具名称列表，为空则启用所有已注册工具',
    type: [String],
    example: ['get_current_time', 'calculate', 'get_weather'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tools?: string[];

  @ApiPropertyOptional({
    description:
      '持久化模式。sync=同步写入（最可靠）；async=异步写入（高性能）；exit=仅退出时写入。',
    enum: DurabilityMode,
    default: DurabilityMode.SYNC,
  })
  @IsEnum(DurabilityMode)
  @IsOptional()
  durability?: DurabilityMode;

  @ApiPropertyOptional({
    description: '温度参数 (0-2)',
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
}

/**
 * 线程感知的 ReAct Agent 对话响应 DTO
 */
export class ThreadChatResponseDto {
  @ApiProperty({
    description: 'Agent 最终文本响应',
    example: '北京现在天气晴朗，温度25°C。',
  })
  content: string;

  @ApiProperty({
    description: '线程 ID（用于后续对话延续状态）',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  threadId: string;

  @ApiPropertyOptional({ description: '推理/思考内容' })
  reasoning?: string;

  @ApiProperty({ description: '迭代次数', example: 3 })
  iterationCount: number;

  @ApiProperty({ description: '工具调用总次数', example: 2 })
  toolCallCount: number;

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
