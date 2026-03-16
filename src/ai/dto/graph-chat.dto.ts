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
 * Graph 消息 DTO
 *
 * 与 ToolCallingMessageDto 结构一致，独立定义以保持 DTO 层自包含性。
 *
 * @example
 * {
 *   role: 'user',
 *   content: '北京今天天气怎么样？现在几点了？'
 * }
 */
export class GraphMessageDto {
  /** @example 'user' */
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  /** @example '北京今天天气怎么样？现在几点了？' */
  @ApiProperty({
    description: '消息内容',
    example: '北京今天天气怎么样？现在几点了？',
  })
  @IsString()
  content: string;
}

/**
 * Graph 对话请求 DTO
 *
 * 用于 StateGraph 和 Functional API 两种模式的工具调用对话。
 * 与 043 ToolCallingChatRequestDto 的字段保持一致，
 * 使调用方可以零成本切换底层实现。
 *
 * @example
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   messages: [
 *     { role: 'user', content: '北京今天天气怎么样？' }
 *   ],
 *   systemPrompt: '你是一个智能助手，可以使用工具来帮助用户。',
 *   tools: ['get_current_time', 'get_weather'],
 *   temperature: 0.7,
 *   maxTokens: 4096,
 *   maxIterations: 5
 * }
 */
export class GraphChatRequestDto {
  /** @example 'siliconflow' */
  @ApiProperty({
    description: 'AI 提供商',
    enum: AiProvider,
    default: AiProvider.SILICONFLOW,
    example: AiProvider.SILICONFLOW,
  })
  @IsEnum(AiProvider)
  provider: AiProvider = AiProvider.SILICONFLOW;

  /** @example 'Pro/MiniMaxAI/MiniMax-M2.5' */
  @ApiProperty({
    description: '模型名称（必须支持 tool calling 能力）',
    default: 'Pro/MiniMaxAI/MiniMax-M2.5',
    example: 'Pro/MiniMaxAI/MiniMax-M2.5',
  })
  @IsString()
  model: string = 'Pro/MiniMaxAI/MiniMax-M2.5';

  /** @example [{ role: 'user', content: '北京今天天气怎么样？' }] */
  @ApiProperty({
    description: '消息列表（支持多轮对话）',
    type: [GraphMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GraphMessageDto)
  messages: GraphMessageDto[];

  /** @example '你是一个智能助手，可以使用工具来帮助用户。' */
  @ApiPropertyOptional({
    description: '系统提示词',
    example:
      '你是一个智能助手，可以使用工具来帮助用户。请根据需要调用工具获取信息。',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  /** @example ['get_current_time', 'calculate', 'get_weather'] */
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

  /** @example 0.7 */
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

  /** @example 4096 */
  @ApiPropertyOptional({
    description: '最大输出 Token 数',
    default: 4096,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  maxTokens?: number;

  /** @example 5 */
  @ApiPropertyOptional({
    description:
      '最大迭代次数（防止无限循环）。' +
      '与 043 的 maxToolRounds 含义一致，对应 StateGraph 的循环上限。',
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
 * Graph 追踪信息 DTO
 *
 * @example
 * {
 *   traceId: 'abc123',
 *   totalLatencyMs: 2500,
 *   llmCallCount: 2,
 *   totalTokens: 1500
 * }
 */
export class GraphTraceDto {
  /** @example 'abc123' */
  @ApiProperty({ description: '追踪 ID' })
  traceId: string;

  /** @example 2500 */
  @ApiProperty({ description: '总耗时（毫秒）' })
  totalLatencyMs: number;

  /** @example 2 */
  @ApiProperty({ description: 'LLM 调用次数' })
  llmCallCount: number;

  /** @example 1500 */
  @ApiProperty({ description: '总 Token 消耗' })
  totalTokens: number;
}

/**
 * Graph 对话响应 DTO
 *
 * 与 ToolCallingResponseDto 的核心字段一致（content, usage），
 * 但用图的指标（iterationCount, toolCallCount）替代 rounds 结构，
 * 并新增 trace 追踪摘要。
 *
 * @example
 * {
 *   content: '北京今天天气晴朗，温度25°C。现在是下午3点30分。',
 *   iterationCount: 2,
 *   toolCallCount: 2,
 *   usage: { promptTokens: 500, completionTokens: 200, totalTokens: 700 },
 *   trace: { traceId: 'abc123', totalLatencyMs: 2500, llmCallCount: 2, totalTokens: 1500 }
 * }
 */
export class GraphChatResponseDto {
  /** @example '北京今天天气晴朗，温度25°C。现在是下午3点30分。' */
  @ApiProperty({
    description: '模型的最终文本响应',
    example: '北京今天天气晴朗，温度25°C。现在是下午3点30分。',
  })
  content: string;

  /** @example 2 */
  @ApiProperty({
    description: '图执行的迭代次数（callModel 节点被调用的次数）',
    example: 2,
  })
  iterationCount: number;

  /** @example 2 */
  @ApiProperty({
    description: '工具调用总次数（所有迭代中工具被调用的总数）',
    example: 2,
  })
  toolCallCount: number;

  /** @example { promptTokens: 500, completionTokens: 200, totalTokens: 700 } */
  @ApiPropertyOptional({
    description: 'Token 使用统计',
  })
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** @example { traceId: 'abc123', totalLatencyMs: 2500, llmCallCount: 2, totalTokens: 1500 } */
  @ApiPropertyOptional({
    description: '链路追踪摘要',
    type: GraphTraceDto,
  })
  trace?: GraphTraceDto;
}
