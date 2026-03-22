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
 * 高级模式通用消息 DTO
 */
class AdvancedPatternMessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '请写一篇关于 TypeScript 泛型的技术博客',
  })
  @IsString()
  content: string;
}

// ============================================================
// Reflection 模式 DTO
// ============================================================

/**
 * Reflection 自我修正请求 DTO
 *
 * @example
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   messages: [{ role: 'user', content: '请写一篇关于 TypeScript 泛型的技术博客' }],
 *   evaluationCriteria: '- 技术准确性\n- 代码示例质量\n- 结构完整性',
 *   maxReflections: 3
 * }
 */
export class ReflectionChatRequestDto {
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
    description: '消息列表（通常包含一条描述生成任务的 user 消息）',
    type: [AdvancedPatternMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AdvancedPatternMessageDto)
  messages: AdvancedPatternMessageDto[];

  @ApiPropertyOptional({
    description: 'Generator 系统提示词。定制生成器的行为和输出风格。',
    example: '你是一位技术博客专家，擅长将复杂概念解释得通俗易懂。',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description:
      '评估标准。以换行分隔的标准列表，注入 Evaluator 提示词。' +
      '不提供时使用默认标准（准确性、完整性、清晰度、质量）。',
    example:
      '- 技术准确性：概念是否正确\n- 代码示例：是否有可运行的示例\n- 结构完整性：是否有引言、正文、总结',
  })
  @IsString()
  @IsOptional()
  evaluationCriteria?: string;

  @ApiPropertyOptional({
    description: '最大反思次数（generate-evaluate 循环上限）',
    default: 3,
    minimum: 1,
    maximum: 5,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(5)
  maxReflections?: number;

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
      'Evaluator 使用的模型（可选，默认与 Generator 相同）。' +
      '生产场景下可让 Evaluator 使用更强的模型做质量把关。',
    example: 'Pro/deepseek/deepseek-chat',
  })
  @IsString()
  @IsOptional()
  evaluatorModel?: string;

  @ApiPropertyOptional({
    description: 'Evaluator 模型的提供商（未指定时使用主提供商）',
    enum: AiProvider,
  })
  @IsEnum(AiProvider)
  @IsOptional()
  evaluatorProvider?: AiProvider;
}

/**
 * Reflection 自我修正响应 DTO
 */
export class ReflectionChatResponseDto {
  @ApiProperty({
    description: '最终生成内容（经过反思修正后的版本）',
  })
  content: string;

  @ApiProperty({
    description: '实际反思轮次（0 = 首次生成即通过评估）',
    example: 2,
  })
  reflectionCount: number;

  @ApiPropertyOptional({
    description: '最终评估分数（0-10）',
    example: 8,
  })
  score?: number;

  @ApiPropertyOptional({
    description: '最终评估反馈',
    example: 'Content is accurate and well-structured.',
  })
  feedback?: string;

  @ApiProperty({
    description: '评估是否通过（false 表示达到最大反思次数后强制返回）',
    example: true,
  })
  passed: boolean;

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
// Plan-Execute 模式 DTO
// ============================================================

/**
 * Plan-Execute 规划执行请求 DTO
 *
 * @example
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   messages: [{ role: 'user', content: '帮我查询北京和上海的天气，比较一下哪个城市更适合出行' }],
 *   tools: ['get_weather', 'get_current_time']
 * }
 */
export class PlanExecuteChatRequestDto {
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
    description: '消息列表（通常包含一条描述复杂目标的 user 消息）',
    type: [AdvancedPatternMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AdvancedPatternMessageDto)
  messages: AdvancedPatternMessageDto[];

  @ApiPropertyOptional({
    description: '系统提示词（额外指导 Planner 的规划策略）',
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
    description: 'Executor 子图（工具调用）的最大迭代次数',
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
 * 步骤执行结果 DTO
 */
class StepResultDto {
  @ApiProperty({ description: '步骤描述' })
  step: string;

  @ApiProperty({ description: '执行结果' })
  result: string;
}

/**
 * Plan-Execute 规划执行响应 DTO
 */
export class PlanExecuteChatResponseDto {
  @ApiProperty({
    description: '最终汇总响应',
  })
  content: string;

  @ApiProperty({
    description: '执行的计划步骤列表',
    type: [String],
    example: ['查询北京天气', '查询上海天气', '对比并给出建议'],
  })
  plan: string[];

  @ApiProperty({
    description: '各步骤的执行结果',
    type: [StepResultDto],
  })
  stepResults: Array<{ step: string; result: string }>;

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
