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
 * 多智能体消息 DTO
 */
class MultiAgentMessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '帮我查询北京的天气，然后计算如果温度每天上升2度，一周后是多少度',
  })
  @IsString()
  content: string;
}

/**
 * 多智能体 Supervisor 对话请求 DTO
 *
 * @example
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   messages: [{ role: 'user', content: '查一下北京天气，再算算温度变化' }]
 * }
 */
export class MultiAgentChatRequestDto {
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
    type: [MultiAgentMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MultiAgentMessageDto)
  messages: MultiAgentMessageDto[];

  @ApiPropertyOptional({
    description:
      'Supervisor 系统提示词。追加到默认提示词之后，用于定制路由行为。',
    example: '优先使用 research_agent 获取信息，仅在需要计算时使用 code_agent',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

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
      '启用的子 Agent 名称列表。为空则启用全部。' +
      '可用: research_agent, code_agent',
    type: [String],
    example: ['research_agent', 'code_agent'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  enabledAgents?: string[];
}

/**
 * Agent 调用统计 DTO
 */
class AgentCallStatsDto {
  @ApiPropertyOptional({
    description: 'research_agent 被调用次数',
    example: 1,
  })
  research_agent?: number;

  @ApiPropertyOptional({
    description: 'code_agent 被调用次数',
    example: 1,
  })
  code_agent?: number;
}

/**
 * 多智能体 Supervisor 对话响应 DTO
 */
export class MultiAgentChatResponseDto {
  @ApiProperty({
    description: '最终响应内容（Supervisor 综合各 Agent 结果后的回复）',
  })
  content: string;

  @ApiProperty({
    description: '各 Agent 被委派的次数',
    type: AgentCallStatsDto,
    example: { research_agent: 1, code_agent: 1 },
  })
  agentCalls: Record<string, number>;

  @ApiProperty({
    description: '总委派轮次',
    example: 2,
  })
  totalDelegations: number;

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
