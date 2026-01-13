import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StreamChunkType } from '../constants';

/**
 * Token 使用统计 DTO
 */
export class TokenUsageDto {
  @ApiProperty({ description: '输入 Token 数' })
  promptTokens: number;

  @ApiProperty({ description: '输出 Token 数' })
  completionTokens: number;

  @ApiProperty({ description: '总 Token 数' })
  totalTokens: number;
}

/**
 * 工具调用信息 DTO
 */
export class ToolCallDto {
  @ApiProperty({ description: '调用 ID' })
  id: string;

  @ApiProperty({ description: '工具名称' })
  name: string;

  @ApiProperty({ description: '调用参数' })
  arguments: Record<string, unknown>;
}

/**
 * 非流式对话响应 DTO
 */
export class ChatResponseDto {
  @ApiProperty({
    description: '响应内容',
    example: '依赖注入是一种设计模式...',
  })
  content: string;

  @ApiPropertyOptional({
    description: '推理/思考过程（仅推理模型返回）',
  })
  reasoning?: string;

  @ApiPropertyOptional({
    description: '工具调用列表',
    type: [ToolCallDto],
  })
  toolCalls?: ToolCallDto[];

  @ApiPropertyOptional({
    description: 'Token 使用统计',
    type: TokenUsageDto,
  })
  usage?: TokenUsageDto;

  @ApiPropertyOptional({
    description: '完成原因',
    example: 'stop',
  })
  finishReason?: string;
}

/**
 * 流式输出块 DTO
 * 用于 SSE 响应
 */
export class StreamChunkDto {
  @ApiProperty({
    description: '块类型',
    enum: StreamChunkType,
    example: StreamChunkType.TEXT,
  })
  type: StreamChunkType;

  @ApiPropertyOptional({
    description: '文本内容',
  })
  content?: string;

  @ApiPropertyOptional({
    description: '工具调用信息',
    type: ToolCallDto,
  })
  toolCall?: ToolCallDto;

  @ApiPropertyOptional({
    description: '错误信息',
  })
  error?: string;
}

/**
 * 推理对话响应 DTO
 * 包含完整的思考过程
 */
export class ReasoningResponseDto extends ChatResponseDto {
  @ApiProperty({
    description: '推理/思考过程',
    example: '让我分析一下这个问题...',
  })
  declare reasoning: string;
}
