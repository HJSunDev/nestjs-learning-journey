import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsEnum,
  Min,
  Max,
  MinLength,
} from 'class-validator';
import { AiProvider } from '../constants';

/**
 * 有状态会话对话请求 DTO
 *
 * 与 ChatRequestDto 的核心差异：
 * - 不传 messages 数组，只传当前轮次的 input 文本
 * - 通过 sessionId 标识会话，服务端自动从 Redis 加载/持久化历史
 * - 支持 windowSize 控制发送给模型的上下文窗口
 */
export class MemoryChatRequestDto {
  @ApiProperty({
    description: '会话 ID（唯一标识一个对话会话，如 UUID 或 user-id:topic）',
    example: 'user-001:general',
  })
  @IsString()
  @MinLength(1)
  sessionId: string;

  @ApiProperty({
    description: '当前轮次的用户输入',
    example: '你好，请介绍一下自己',
  })
  @IsString()
  @MinLength(1)
  input: string;

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
    description: '系统提示词（定义 AI 角色和行为约束）',
    example: '你是一个专业的 NestJS 技术顾问',
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

  @ApiPropertyOptional({
    description:
      '历史窗口大小（消息条数），控制发送给模型的上下文长度，0 表示不裁剪',
    default: 20,
    minimum: 0,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  maxHistoryLength?: number;

  @ApiPropertyOptional({
    description: '会话 TTL（秒），每次对话后自动刷新，到期自动清除',
    default: 3600,
    minimum: 0,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  sessionTTL?: number;
}

/**
 * 有状态会话对话响应 DTO
 */
export class MemoryChatResponseDto {
  @ApiProperty({ description: '会话 ID' })
  sessionId: string;

  @ApiProperty({ description: 'AI 回复内容' })
  content: string;

  @ApiPropertyOptional({ description: '推理过程（仅推理模式）' })
  reasoning?: string;

  @ApiPropertyOptional({
    description: 'Token 使用统计',
  })
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  @ApiPropertyOptional({ description: '完成原因' })
  finishReason?: string;
}

/**
 * 会话历史查询响应 DTO
 */
export class SessionHistoryResponseDto {
  @ApiProperty({ description: '会话 ID' })
  sessionId: string;

  @ApiProperty({
    description: '消息列表',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        content: { type: 'string' },
      },
    },
  })
  messages: { role: string; content: string }[];

  @ApiProperty({ description: '消息总数' })
  messageCount: number;

  @ApiProperty({ description: '剩余 TTL（秒），-1 表示无过期' })
  ttl: number;
}

/**
 * 清除会话响应 DTO
 */
export class ClearSessionResponseDto {
  @ApiProperty({ description: '被清除的会话 ID' })
  sessionId: string;

  @ApiProperty({ description: '被删除的消息条数' })
  deletedMessageCount: number;

  @ApiProperty({ description: '操作结果描述' })
  message: string;
}

/**
 * 会话列表响应 DTO
 */
export class SessionListResponseDto {
  @ApiProperty({ description: '活跃会话列表' })
  sessions: {
    sessionId: string;
    messageCount: number;
    ttl: number;
  }[];

  @ApiProperty({ description: '会话总数' })
  total: number;
}
