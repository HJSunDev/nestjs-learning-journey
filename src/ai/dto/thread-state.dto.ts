import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 序列化后的消息 DTO
 */
export class SerializedMessageDto {
  @ApiProperty({
    description: '消息类型: human | ai | tool | system',
    example: 'ai',
  })
  type: string;

  @ApiProperty({ description: '消息文本内容', example: '北京今天天气晴朗。' })
  content: string;

  @ApiPropertyOptional({ description: '工具调用列表（仅 AI 消息）' })
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;

  @ApiPropertyOptional({ description: '工具调用 ID（仅 Tool 消息）' })
  toolCallId?: string;

  @ApiPropertyOptional({ description: '工具名称（仅 Tool 消息）' })
  name?: string;
}

/**
 * 线程状态快照响应 DTO
 *
 * 对应一个 super-step 边界的 checkpoint，
 * 包含当前的完整状态值、待执行的下一个节点和元数据。
 */
export class ThreadStateResponseDto {
  @ApiProperty({
    description: '线程 ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  threadId: string;

  @ApiProperty({
    description: 'Checkpoint ID（唯一标识此快照）',
    example: '1ef663ba-28fe-6528-8002-5a559208592c',
  })
  checkpointId: string;

  @ApiProperty({
    description: 'Checkpoint 命名空间（子图标识，根图为空字符串）',
    example: '',
  })
  checkpointNs: string;

  @ApiProperty({ description: '当前状态值' })
  values: {
    messages: SerializedMessageDto[];
    toolCallCount: number;
    iterationCount: number;
  };

  @ApiProperty({
    description: '待执行的下一个节点列表（空数组表示图已完成）',
    type: [String],
    example: [],
  })
  next: string[];

  @ApiProperty({ description: '元数据' })
  metadata: {
    source: string;
    step: number;
    writes: Record<string, unknown> | null;
  };

  @ApiProperty({
    description: 'Checkpoint 创建时间',
    example: '2026-03-19T21:00:00.000Z',
  })
  createdAt: string;

  @ApiPropertyOptional({
    description: '父 Checkpoint ID（首个 checkpoint 为 null）',
    example: '1ef663ba-28f9-6ec4-8001-31981c2c39f8',
  })
  parentCheckpointId: string | null;
}

/**
 * 线程历史查询参数 DTO
 */
export class ThreadHistoryQueryDto {
  @ApiPropertyOptional({
    description: '返回的最大记录数',
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  // Query 参数始终以字符串形式到达，需要 @Type(() => Number) 先转型，@IsNumber() 才能正确校验。
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * 线程分叉请求 DTO
 *
 * 从指定的历史 checkpoint 创建新的分支，支持修改状态值后继续执行。
 */
export class ThreadForkRequestDto {
  @ApiProperty({
    description: '要分叉的历史 Checkpoint ID',
    example: '1ef663ba-28f9-6ec4-8001-31981c2c39f8',
  })
  @IsString()
  checkpointId: string;

  @ApiPropertyOptional({
    description:
      '指定更新被视为来自哪个节点（影响后续执行的节点选择）。' +
      '例如指定 "callModel" 则后续从 shouldContinue 继续。',
    example: 'callModel',
  })
  @IsString()
  @IsOptional()
  asNode?: string;
}

/**
 * 线程分叉响应 DTO
 */
export class ThreadForkResponseDto {
  @ApiProperty({ description: '分叉操作是否成功' })
  success: boolean;

  @ApiProperty({ description: '分叉后的线程配置' })
  configurable: Record<string, string>;

  @ApiPropertyOptional({ description: '操作说明' })
  message?: string;
}
