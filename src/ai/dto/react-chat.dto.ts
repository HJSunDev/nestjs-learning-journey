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
 * ReAct 消息 DTO
 */
export class ReactMessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '帮我查一下北京现在的天气，以及现在几点了',
  })
  @IsString()
  content: string;
}

/**
 * ReAct Agent 对话请求 DTO
 *
 * @example
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   messages: [{ role: 'user', content: '帮我查一下北京现在的天气' }],
 *   maxIterations: 5
 * }
 */
export class ReactChatRequestDto {
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
    description: '消息列表',
    type: [ReactMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReactMessageDto)
  messages: ReactMessageDto[];

  @ApiPropertyOptional({
    description:
      '自定义系统提示词。不提供时使用内置 ReAct 提示词（引导 Thought → Action → Observation 循环）。',
    example: '你是一个智能助手，遵循 ReAct 范式思考和行动。',
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
    description:
      '最大迭代次数（ReAct 循环上限），对应 shouldContinue 的 maxIterations。',
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
 * ReAct Agent 对话响应 DTO
 *
 * @example
 * {
 *   content: '北京现在天气晴朗，温度25°C。当前时间是15:30。',
 *   reasoning: '先获取北京天气，再获取当前时间，最后整合回答。',
 *   iterationCount: 3,
 *   toolCallCount: 2,
 *   usage: { promptTokens: 500, completionTokens: 200, totalTokens: 700 },
 *   trace: { traceId: 'abc123', totalLatencyMs: 3000, llmCallCount: 3, totalTokens: 1500 }
 * }
 */
export class ReactChatResponseDto {
  @ApiProperty({
    description: 'Agent 最终文本响应',
    example: '北京现在天气晴朗，温度25°C。当前时间是15:30。',
  })
  content: string;

  @ApiPropertyOptional({
    description: '模型返回的思考/推理内容（模型支持时才会返回）',
    example:
      '先分别获取北京和上海的天气，再对比温度、天气状况和空气质量，最后给出户外运动建议。',
  })
  reasoning?: string;

  @ApiProperty({
    description: 'ReAct 迭代次数（Thought-Action-Observation 循环次数）',
    example: 3,
  })
  iterationCount: number;

  @ApiProperty({
    description: '工具调用总次数',
    example: 2,
  })
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
