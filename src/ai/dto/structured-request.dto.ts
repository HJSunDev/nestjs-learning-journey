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
 * 结构化输出的消息 DTO
 *
 * 与 ChatRequestDto 中的 MessageDto 结构一致，
 * 独立定义以保持 DTO 层的自包含性。
 */
export class StructuredMessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '请分析这段文本的情感倾向',
  })
  @IsString()
  content: string;
}

/**
 * 结构化多轮对话请求 DTO
 *
 * 在标准对话请求基础上增加 schemaName 字段，
 * 指定模型应以哪种预定义 Schema 格式返回结构化数据。
 */
export class StructuredChatRequestDto {
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
    description: '预定义 Schema 名称（通过 GET /schemas 查看可用列表）',
    example: 'sentiment-analysis',
  })
  @IsString()
  schemaName: string;

  @ApiProperty({
    description: '消息列表（支持多轮对话）',
    type: [StructuredMessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StructuredMessageDto)
  messages: StructuredMessageDto[];

  @ApiPropertyOptional({
    description: '系统提示词',
    example: '你是一个专业的文本分析助手，请严格按照指定格式返回分析结果。',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description: '温度参数 (0-2)，结构化输出建议使用较低值以提高一致性',
    default: 0,
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
}

/**
 * 结构化快速提取请求 DTO
 *
 * 单轮场景：直接传入文本 + Schema 名称，提取结构化信息。
 * 适用于情感分析、实体提取、内容分类等非对话类任务。
 */
export class StructuredExtractRequestDto {
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
    description: '预定义 Schema 名称',
    example: 'entity-extraction',
  })
  @IsString()
  schemaName: string;

  @ApiProperty({
    description: '待分析的文本内容',
    example: '2024年3月，马斯克在得克萨斯州宣布 SpaceX 星舰第三次试飞成功。',
  })
  @IsString()
  prompt: string;

  @ApiPropertyOptional({
    description: '系统提示词（覆盖默认的提取指令）',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description: '温度参数 (0-2)',
    default: 0,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(2)
  temperature?: number;
}

/**
 * 结构化输出响应 DTO
 *
 * 将模型的结构化输出（parsed）和运行时元数据（usage）统一返回。
 * data 字段为泛化的 JSON 对象，其具体结构取决于请求中指定的 schemaName。
 */
export class StructuredResponseDto {
  @ApiProperty({
    description: '使用的 Schema 名称',
    example: 'sentiment-analysis',
  })
  schemaName: string;

  @ApiProperty({
    description: '结构化输出数据（结构由所选 Schema 决定）',
    example: {
      sentiment: 'positive',
      confidence: 0.92,
      keywords: ['success', 'innovative'],
      summary: 'The text expresses a positive sentiment.',
    },
  })
  data: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Token 使用统计',
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
