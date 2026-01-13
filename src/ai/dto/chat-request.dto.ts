import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  ValidateNested,
  IsEnum,
  Min,
  Max,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AiProvider, MessageRole } from '../constants';

/**
 * 消息 DTO
 * 用于多轮对话的单条消息
 */
export class MessageDto {
  @ApiProperty({
    description: '消息角色',
    enum: MessageRole,
    example: MessageRole.USER,
  })
  @IsEnum(MessageRole)
  role: MessageRole;

  @ApiProperty({
    description: '消息内容',
    example: '你好，请介绍一下自己',
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
 * 对话请求 DTO
 */
export class ChatRequestDto {
  @ApiProperty({
    description: 'AI 提供商',
    enum: AiProvider,
    example: AiProvider.DEEPSEEK,
  })
  @IsEnum(AiProvider)
  provider: AiProvider;

  @ApiProperty({
    description: '模型名称',
    example: 'deepseek-chat',
  })
  @IsString()
  model: string;

  @ApiProperty({
    description: '消息列表（支持多轮对话）',
    type: [MessageDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MessageDto)
  messages: MessageDto[];

  @ApiPropertyOptional({
    description: '系统提示词',
    example: '你是一个专业的技术顾问',
  })
  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @ApiPropertyOptional({
    description: '温度参数 (0-2)，值越高回复越随机',
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
    description: '是否启用推理模式（获取思考过程）',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  enableReasoning?: boolean;

  @ApiPropertyOptional({
    description: '启用的工具名称列表',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tools?: string[];
}

/**
 * 简化的快速对话请求 DTO
 * 用于单轮对话场景
 */
export class QuickChatRequestDto {
  @ApiProperty({
    description: 'AI 提供商',
    enum: AiProvider,
    example: AiProvider.DEEPSEEK,
  })
  @IsEnum(AiProvider)
  provider: AiProvider;

  @ApiProperty({
    description: '模型名称',
    example: 'deepseek-chat',
  })
  @IsString()
  model: string;

  @ApiProperty({
    description: '用户输入',
    example: '解释一下什么是依赖注入',
  })
  @IsString()
  prompt: string;

  @ApiPropertyOptional({
    description: '系统提示词',
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
}
