import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsEnum,
  ValidateNested,
  ArrayMinSize,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AiProvider, MessageRole } from '../constants';

/**
 * 工具调用消息 DTO
 *
 * 与标准 ChatRequestDto 中的 MessageDto 结构一致，
 * 独立定义以保持 DTO 层的自包含性。
 */
export class ToolCallingMessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '北京今天天气怎么样？',
  })
  @IsString()
  content: string;

  @ApiPropertyOptional({
    description: '工具调用 ID（仅 tool 角色使用）',
  })
  @IsString()
  @IsOptional()
  toolCallId?: string;
}

/**
 * 工具调用对话请求 DTO
 *
 * 在标准对话请求基础上增加 tools（指定启用的工具）和 maxToolRounds（防止无限循环）。
 * 模型会根据对话内容自主决定是否调用工具、调用哪些工具。
 */
export class ToolCallingChatRequestDto {
  @ApiProperty({
    description: 'AI 提供商',
    enum: AiProvider,
    default: AiProvider.SILICONFLOW,
    example: AiProvider.SILICONFLOW,
  })
  @IsEnum(AiProvider)
  provider: AiProvider = AiProvider.SILICONFLOW;

  @ApiProperty({
    description: '模型名称（必须支持 tool calling 能力）',
    default: 'Pro/MiniMaxAI/MiniMax-M2.5',
    example: 'Pro/MiniMaxAI/MiniMax-M2.5',
  })
  @IsString()
  model: string = 'Pro/MiniMaxAI/MiniMax-M2.5';

  @ApiProperty({
    description: '消息列表（支持多轮对话）',
    type: [ToolCallingMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ToolCallingMessageDto)
  messages: ToolCallingMessageDto[];

  @ApiPropertyOptional({
    description: '系统提示词',
    example:
      '你是一个智能助手，可以使用工具来帮助用户。请根据需要调用工具获取信息。',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description:
      '启用的工具名称列表。为空则启用所有已注册工具。' +
      '通过 GET /ai/lcel/tools 查看可用工具列表。',
    type: [String],
    example: ['get_current_time', 'calculate', 'get_weather'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tools?: string[];

  @ApiPropertyOptional({
    description: '温度参数 (0-2)，工具调用场景建议使用较低值以提高稳定性',
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
    description:
      '最大工具调用轮次（防止无限循环）。' +
      '每轮可包含多个并行工具调用，大多数场景 2-3 轮即可。',
    default: 5,
    minimum: 1,
    maximum: 10,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(10)
  maxToolRounds?: number;
}

/**
 * 单次工具调用信息（面向 API 响应）
 */
export class ToolCallInfoDto {
  @ApiProperty({ description: '工具调用 ID', example: 'call_abc123' })
  id: string;

  @ApiProperty({ description: '工具名称', example: 'get_weather' })
  name: string;

  @ApiProperty({
    description: '模型传入的调用参数',
    example: { city: '北京' },
  })
  arguments: Record<string, unknown>;
}

/**
 * 单次工具执行结果（面向 API 响应）
 */
export class ToolResultInfoDto {
  @ApiProperty({ description: '对应的工具调用 ID', example: 'call_abc123' })
  toolCallId: string;

  @ApiProperty({ description: '工具名称', example: 'get_weather' })
  name: string;

  @ApiProperty({
    description: '工具执行结果',
    example: '北京当前天气：温度 25°C，晴，东南风 2级。',
  })
  result: unknown;
}

/**
 * 单轮工具调用记录（面向 API 响应）
 */
export class ToolCallRoundDto {
  @ApiProperty({ description: '轮次序号', example: 1 })
  round: number;

  @ApiProperty({
    description: '本轮所有工具调用',
    type: [ToolCallInfoDto],
  })
  toolCalls: ToolCallInfoDto[];

  @ApiProperty({
    description: '本轮所有工具执行结果',
    type: [ToolResultInfoDto],
  })
  toolResults: ToolResultInfoDto[];
}

/**
 * 工具调用对话响应 DTO
 *
 * 除了最终的文本响应，还包含完整的工具调用历史，
 * 客户端可据此展示工具调用过程（如折叠面板、时间线等）。
 */
export class ToolCallingResponseDto {
  @ApiProperty({
    description: '模型的最终文本响应（在所有工具调用完成后生成）',
    example: '北京今天天气晴朗，温度25°C，适合出门活动。',
  })
  content: string;

  @ApiProperty({
    description: '工具调用历史（按轮次组织）',
    type: [ToolCallRoundDto],
  })
  rounds: ToolCallRoundDto[];

  @ApiProperty({
    description: '总共经历的工具调用轮次',
    example: 1,
  })
  totalRounds: number;

  @ApiPropertyOptional({
    description: 'Token 使用统计（仅最终轮次的 usage）',
  })
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  @ApiPropertyOptional({
    description: '完成原因',
    example: 'stop',
  })
  finishReason?: string;
}
