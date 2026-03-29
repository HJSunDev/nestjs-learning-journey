import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  IsEnum,
  ValidateNested,
  ArrayMinSize,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AiProvider, MessageRole } from '../constants';

/**
 * Ops 消息 DTO
 */
class OpsMessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '帮我查询北京的天气，然后分析一下',
  })
  @IsString()
  content: string;
}

/**
 * 生产级 Agent 运维对话请求 DTO
 *
 * 在多智能体能力之上叠加生产运维特性：
 * 熔断保护、上下文压缩、输入/输出双向守卫、全链路指标收集。
 *
 * @example
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   messages: [{ role: 'user', content: '查一下北京天气' }],
 *   enableCircuitBreaker: true,
 *   enableCompaction: true,
 *   enableOutputGuardrail: true
 * }
 */
export class OpsChatRequestDto {
  @ApiProperty({
    description: 'AI 提供商',
    enum: AiProvider,
    default: AiProvider.SILICONFLOW,
  })
  @IsEnum(AiProvider)
  provider: AiProvider = AiProvider.SILICONFLOW;

  @ApiProperty({
    description: '模型名称（必须支持 tool calling）',
    default: 'Pro/MiniMaxAI/MiniMax-M2.5',
  })
  @IsString()
  model: string = 'Pro/MiniMaxAI/MiniMax-M2.5';

  @ApiProperty({
    description: '消息列表',
    type: [OpsMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OpsMessageDto)
  messages: OpsMessageDto[];

  @ApiPropertyOptional({
    description: 'Supervisor 系统提示词',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description: '温度参数 (0-2)',
    default: 0.7,
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
    description: '启用的子 Agent 名称列表',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  enabledAgents?: string[];

  // ── 运维能力开关 ──

  @ApiPropertyOptional({
    description: '是否启用熔断保护（默认 true）',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  enableCircuitBreaker?: boolean;

  @ApiPropertyOptional({
    description: '是否启用上下文压缩（默认 true）',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  enableCompaction?: boolean;

  @ApiPropertyOptional({
    description: '压缩策略: trim（裁剪）/ summarize（摘要+裁剪）',
    default: 'trim',
  })
  @IsString()
  @IsOptional()
  compactionStrategy?: 'trim' | 'summarize';

  @ApiPropertyOptional({
    description: '是否启用输出守卫（默认 true）',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  enableOutputGuardrail?: boolean;

  @ApiPropertyOptional({
    description: '是否启用 PII 脱敏（默认 true）',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  enablePiiSanitization?: boolean;
}

/**
 * 运维指标 DTO（嵌套在响应中）
 *
 * 对齐 AgentMetrics 接口，但只暴露 API 消费方关心的字段。
 */
class OpsMetricsDto {
  @ApiProperty({ description: '请求 ID' })
  requestId: string;

  @ApiProperty({ description: '总延迟 (ms)' })
  totalLatencyMs: number;

  @ApiProperty({ description: 'LLM 调用次数' })
  llmCallCount: number;

  @ApiProperty({ description: '工具调用次数' })
  toolCallCount: number;

  @ApiProperty({ description: '执行状态' })
  status: string;

  @ApiPropertyOptional({ description: '提供商' })
  provider?: string;

  @ApiPropertyOptional({ description: '模型' })
  model?: string;

  @ApiPropertyOptional({ description: 'Token 用量' })
  tokenUsage?: { input: number; output: number; total: number };

  @ApiPropertyOptional({ description: '熔断器状态' })
  circuitBreakerState?: string;

  @ApiPropertyOptional({ description: '是否执行了上下文压缩' })
  contextCompacted?: boolean;

  @ApiPropertyOptional({ description: '输出守卫触发规则' })
  guardrailTriggered?: string[];

  @ApiPropertyOptional({ description: '重试次数' })
  retryCount?: number;

  @ApiPropertyOptional({ description: '是否使用降级模型' })
  fallbackUsed?: boolean;
}

/**
 * 生产级 Agent 运维对话响应 DTO
 */
export class OpsChatResponseDto {
  @ApiProperty({ description: '最终响应内容' })
  content: string;

  @ApiProperty({
    description: '各 Agent 被委派的次数',
    example: { research_agent: 1, code_agent: 1 },
  })
  agentCalls: Record<string, number>;

  @ApiProperty({ description: '总委派轮次' })
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

  @ApiPropertyOptional({
    description: '运维指标报告',
    type: OpsMetricsDto,
  })
  metrics?: OpsMetricsDto;
}
