import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { StreamChunkType } from '../constants';

/**
 * Token 使用统计 DTO
 */
@Exclude()
export class TokenUsageDto {
  @ApiProperty({ description: '输入 Token 数' })
  @Expose()
  promptTokens: number;

  @ApiProperty({ description: '输出 Token 数' })
  @Expose()
  completionTokens: number;

  @ApiProperty({ description: '总 Token 数' })
  @Expose()
  totalTokens: number;
}

/**
 * 工具调用信息 DTO
 */
@Exclude()
export class ToolCallDto {
  @ApiProperty({ description: '调用 ID' })
  @Expose()
  id: string;

  @ApiProperty({ description: '工具名称' })
  @Expose()
  name: string;

  @ApiProperty({ description: '调用参数' })
  @Expose()
  arguments: Record<string, unknown>;
}

/**
 * 非流式对话响应 DTO
 */
@Exclude()
export class ChatResponseDto {
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
    description: '工具调用列表',
    type: [ToolCallDto],
  })
  @Expose()
  toolCalls?: ToolCallDto[];

  @ApiPropertyOptional({
    description: 'Token 使用统计',
    type: TokenUsageDto,
  })
  @Expose()
  usage?: TokenUsageDto;

  @ApiPropertyOptional({
    description: '完成原因',
    example: 'stop',
  })
  @Expose()
  finishReason?: string;
}

/**
 * 流式输出块 DTO
 * 用于 SSE 响应
 */
@Exclude()
export class StreamChunkDto {
  @ApiProperty({
    description: '块类型',
    enum: StreamChunkType,
    example: StreamChunkType.TEXT,
  })
  @Expose()
  type: StreamChunkType;

  @ApiPropertyOptional({
    description: '文本内容',
  })
  @Expose()
  content?: string;

  @ApiPropertyOptional({
    description: '工具调用信息',
    type: ToolCallDto,
  })
  @Expose()
  toolCall?: ToolCallDto;

  @ApiPropertyOptional({
    description: '错误信息',
  })
  @Expose()
  error?: string;
}

/**
 * 推理对话响应 DTO
 * 包含完整的思考过程
 */
@Exclude()
export class ReasoningResponseDto extends ChatResponseDto {
  @ApiProperty({
    description: '推理/思考过程',
    example: '让我分析一下这个问题...',
  })
  @Expose()
  declare reasoning: string;
}
