import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsEnum,
  IsUUID,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AiProvider, MessageRole } from '../constants';
import { ReviewAction } from '../agents/hitl/hitl.types';

// ============================================================
// HITL Chat Request — 首次调用
// ============================================================

/**
 * HITL 消息 DTO
 */
export class HitlMessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '帮我发一封邮件给张三',
  })
  @IsString()
  content: string;
}

/**
 * HITL 对话请求 DTO — 首次调用（050 Human-in-the-Loop）
 *
 * 与 ThreadChatRequestDto（049）的核心差异：
 * - 内置人类审批流程：工具调用前触发 interrupt()，等待人类审批
 * - autoApproveTools：免审批工具白名单（低风险工具可跳过审批）
 * - 返回时可能是 interrupted 状态，需要通过 resume 端点继续
 *
 * @example
 * // 参数示例（首次调用）
 * {
 *   provider: 'siliconflow',
 *   model: 'Pro/MiniMaxAI/MiniMax-M2.5',
 *   messages: [{ role: 'user', content: '帮我查一下北京天气' }],
 *   threadId: '550e8400-e29b-41d4-a716-446655440000',
 *   autoApproveTools: ['get_current_time']
 * }
 */
export class HitlChatRequestDto {
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
    description:
      '线程 ID（UUID v4）。HITL 必须指定 thread_id，因为 interrupt/resume 依赖持久化状态。',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4')
  threadId: string;

  @ApiPropertyOptional({
    description: '消息列表',
    type: [HitlMessageDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HitlMessageDto)
  @IsOptional()
  messages?: HitlMessageDto[];

  @ApiPropertyOptional({
    description: '自定义系统提示词',
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
    description:
      '免审批工具白名单。列表中的工具调用不触发 interrupt，直接执行。' +
      '适用于低风险工具（如查询时间），减少不必要的人工干预。',
    type: [String],
    example: ['get_current_time'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  autoApproveTools?: string[];

  @ApiPropertyOptional({
    description: '持久化模式',
    enum: ['sync', 'async', 'exit'],
    default: 'sync',
  })
  @IsString()
  @IsOptional()
  durability?: 'sync' | 'async' | 'exit';

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
    description: '最大迭代次数',
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

// ============================================================
// HITL Resume — 审批恢复
// ============================================================

/**
 * 修改后的工具调用 DTO
 */
export class EditedToolCallDto {
  @ApiProperty({ description: '原始工具调用 ID', example: 'tc_abc123' })
  @IsString()
  id: string;

  @ApiProperty({ description: '工具名称', example: 'get_weather' })
  @IsString()
  name: string;

  @ApiProperty({
    description: '修改后的参数',
    example: { city: '上海' },
  })
  args: Record<string, unknown>;
}

/**
 * 审批决策 DTO
 *
 * 对齐生产标准的二元审批模型（Claude Agent SDK / OpenAI Agents SDK）：
 * - approve: 批准执行（可选携带修改后的参数）
 * - reject:  驳回执行（可选携带原因）
 *
 * @example
 * // 批准（按原样执行）
 * { action: 'approve' }
 *
 * @example
 * // 批准并修改参数（对齐 Claude SDK 的 PermissionResultAllow(updated_input)）
 * {
 *   action: 'approve',
 *   updatedInput: [{ id: 'tc_abc', name: 'get_weather', args: { city: '上海' } }]
 * }
 *
 * @example
 * // 驳回并提供原因
 * { action: 'reject', reason: '不需要查天气，请直接回答' }
 */
export class ReviewDecisionDto {
  @ApiProperty({
    description:
      '审批动作。approve=批准执行（可选携带 updatedInput 修改参数）；' +
      'reject=驳回（可选携带 reason 反馈给模型）',
    enum: ReviewAction,
    example: ReviewAction.APPROVE,
  })
  @IsEnum(ReviewAction)
  action: ReviewAction;

  @ApiPropertyOptional({
    description:
      '驳回原因（action=reject 时使用，模型会在下一轮推理中看到此反馈）',
    example: '此操作风险过高，请换用其他方式',
  })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({
    description:
      '修改后的工具调用参数（action=approve 时可选）。' +
      '不传则按模型原始参数执行，传入则用修改后的参数替换原始 tool_calls。' +
      '对齐 Claude Agent SDK 的 PermissionResultAllow(updated_input) 模式。',
    type: [EditedToolCallDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EditedToolCallDto)
  @IsOptional()
  updatedInput?: EditedToolCallDto[];
}

/**
 * 逐工具审批决策 DTO — per-tool 粒度
 *
 * 对齐 OpenAI Agents SDK 的 interruptions 数组模式：
 * 客户端可为每个工具调用提交独立的 approve/reject 决策。
 *
 * @example
 * { toolCallId: 'tc_abc', action: 'approve' }
 *
 * @example
 * { toolCallId: 'tc_def', action: 'reject', reason: '不要发邮件' }
 *
 * @example
 * { toolCallId: 'tc_ghi', action: 'approve', updatedArgs: { city: '上海' } }
 */
export class ToolCallDecisionDto {
  @ApiProperty({
    description: '对应的工具调用 ID（来自中断载荷中的 toolCalls[].id）',
    example: 'tc_abc123',
  })
  @IsString()
  toolCallId: string;

  @ApiProperty({
    description: '审批动作',
    enum: ReviewAction,
    example: ReviewAction.APPROVE,
  })
  @IsEnum(ReviewAction)
  action: ReviewAction;

  @ApiPropertyOptional({
    description: '驳回原因（action=reject 时使用）',
    example: '此操作风险过高',
  })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({
    description: '修改后的参数（action=approve 时可选）',
    example: { city: '上海' },
  })
  @IsOptional()
  updatedArgs?: Record<string, unknown>;
}

/**
 * HITL 恢复执行请求 DTO
 *
 * 支持两种审批粒度模式（二选一）：
 *
 * 1. 批量模式（decision）：统一 approve 或 reject 所有待审批工具
 * 2. 逐工具模式（toolDecisions）：每个工具独立决策
 *
 * @example
 * // 批量模式 — 批准所有
 * {
 *   threadId: '550e8400-...',
 *   decision: { action: 'approve' }
 * }
 *
 * @example
 * // 逐工具模式 — 混合决策
 * {
 *   threadId: '550e8400-...',
 *   toolDecisions: [
 *     { toolCallId: 'tc_abc', action: 'approve' },
 *     { toolCallId: 'tc_def', action: 'reject', reason: '不要发邮件' }
 *   ]
 * }
 */
export class HitlResumeRequestDto {
  @ApiProperty({
    description: '线程 ID（必须与首次调用一致）',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('4')
  threadId: string;

  @ApiProperty({
    description: 'AI 提供商（恢复后可能触发新的模型调用）',
    enum: AiProvider,
    default: AiProvider.SILICONFLOW,
  })
  @IsEnum(AiProvider)
  provider: AiProvider = AiProvider.SILICONFLOW;

  @ApiProperty({
    description: '模型名称',
    default: 'Pro/MiniMaxAI/MiniMax-M2.5',
  })
  @IsString()
  model: string = 'Pro/MiniMaxAI/MiniMax-M2.5';

  @ApiPropertyOptional({
    description:
      '批量审批决策 — 统一对所有待审批工具执行相同动作。' +
      '与 toolDecisions 二选一，不可同时使用。',
    type: ReviewDecisionDto,
  })
  @ValidateNested()
  @Type(() => ReviewDecisionDto)
  @IsOptional()
  decision?: ReviewDecisionDto;

  @ApiPropertyOptional({
    description:
      '逐工具审批决策 — 为每个工具调用提交独立决策。' +
      '与 decision 二选一，不可同时使用。',
    type: [ToolCallDecisionDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ToolCallDecisionDto)
  @IsOptional()
  toolDecisions?: ToolCallDecisionDto[];

  @ApiPropertyOptional({
    description: '免审批工具白名单',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  autoApproveTools?: string[];

  @ApiPropertyOptional({
    description: '启用的工具名称列表',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tools?: string[];

  @ApiPropertyOptional({ description: '持久化模式' })
  @IsString()
  @IsOptional()
  durability?: 'sync' | 'async' | 'exit';

  @ApiPropertyOptional({ description: '温度参数' })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ description: '最大输出 Token 数' })
  @IsNumber()
  @IsOptional()
  @Min(1)
  maxTokens?: number;

  @ApiPropertyOptional({ description: '最大迭代次数' })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(10)
  maxIterations?: number;
}

// ============================================================
// HITL Response
// ============================================================

/**
 * 中断载荷中的工具调用信息 DTO
 */
export class InterruptToolCallDto {
  @ApiProperty({ description: '工具调用 ID', example: 'tc_abc123' })
  id: string;

  @ApiProperty({ description: '工具名称', example: 'get_weather' })
  name: string;

  @ApiProperty({
    description: '调用参数',
    example: { city: '北京' },
  })
  arguments: Record<string, unknown>;
}

/**
 * 中断载荷 DTO
 */
export class InterruptPayloadDto {
  @ApiProperty({
    description: '中断类型标识',
    example: 'tool_call_review',
  })
  type: string;

  @ApiProperty({
    description: '待审批的工具调用列表',
    type: [InterruptToolCallDto],
  })
  toolCalls: InterruptToolCallDto[];

  @ApiProperty({
    description: '面向审批人的可读提示',
    example: 'Agent 请求调用 2 个工具，请审批。',
  })
  message: string;
}

/**
 * HITL 对话响应 DTO
 *
 * status 字段标识执行状态：
 * - completed: 图正常完成，content 字段有值
 * - interrupted: 图在 interrupt() 处暂停，interrupt 字段有值，需通过 resume 端点继续
 */
export class HitlChatResponseDto {
  @ApiProperty({
    description: '执行状态：completed=完成；interrupted=等待审批',
    enum: ['completed', 'interrupted'],
    example: 'interrupted',
  })
  status: 'completed' | 'interrupted';

  @ApiProperty({
    description: '线程 ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  threadId: string;

  @ApiPropertyOptional({
    description: 'Agent 最终文本响应（status=completed 时有值）',
  })
  content?: string;

  @ApiPropertyOptional({ description: '推理/思考内容' })
  reasoning?: string;

  @ApiPropertyOptional({ description: '迭代次数' })
  iterationCount?: number;

  @ApiPropertyOptional({ description: '工具调用总次数' })
  toolCallCount?: number;

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
    description: '中断载荷（status=interrupted 时有值）',
    type: InterruptPayloadDto,
  })
  interrupt?: InterruptPayloadDto;
}
