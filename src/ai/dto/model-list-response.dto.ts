import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Exclude, Type } from 'class-transformer';
import { AiProvider } from '../constants';

/**
 * 模型能力 DTO
 */
@Exclude()
export class ModelCapabilitiesDto {
  @ApiProperty({ description: '支持思维链推理' })
  @Expose()
  reasoning: boolean;

  @ApiProperty({ description: '支持流式响应' })
  @Expose()
  streaming: boolean;

  @ApiProperty({ description: '支持工具调用' })
  @Expose()
  toolCalls: boolean;
}

/**
 * 模型定价 DTO（单位：元 / 千 Tokens）
 */
@Exclude()
export class ModelPricingDto {
  @ApiProperty({ description: '输入 Token 单价', example: 0.0021 })
  @Expose()
  input: number;

  @ApiProperty({ description: '输出 Token 单价', example: 0.0084 })
  @Expose()
  output: number;

  @ApiPropertyOptional({
    description: '缓存命中输入 Token 单价',
    example: 0.00021,
  })
  @Expose()
  cachedInput?: number;
}

/**
 * 单个模型信息 DTO
 */
@Exclude()
export class ModelInfoDto {
  @ApiProperty({
    description: '模型 ID（用于 API 调用）',
    example: 'Pro/MiniMaxAI/MiniMax-M2.5',
  })
  @Expose()
  id: string;

  @ApiProperty({
    description: '模型展示名称',
    example: 'MiniMax-M2.5 (Pro)',
  })
  @Expose()
  name: string;

  @ApiProperty({
    description: 'API 提供商',
    enum: AiProvider,
    example: AiProvider.SILICONFLOW,
  })
  @Expose()
  provider: AiProvider;

  @ApiProperty({
    description: '模型原始厂商',
    example: 'MiniMax',
  })
  @Expose()
  vendor: string;

  @ApiProperty({
    description: '最大上下文窗口（Token 数）',
    example: 192000,
  })
  @Expose()
  contextWindow: number;

  @ApiProperty({
    description: '模型能力',
    type: ModelCapabilitiesDto,
  })
  @Expose()
  @Type(() => ModelCapabilitiesDto)
  capabilities: ModelCapabilitiesDto;

  @ApiPropertyOptional({
    description: '定价信息（元 / 千 Tokens）',
    type: ModelPricingDto,
  })
  @Expose()
  @Type(() => ModelPricingDto)
  pricing?: ModelPricingDto;
}

/**
 * 模型列表响应 DTO
 */
@Exclude()
export class ModelListResponseDto {
  @ApiProperty({
    description: '可用模型列表',
    type: [ModelInfoDto],
  })
  @Expose()
  @Type(() => ModelInfoDto)
  models: ModelInfoDto[];

  @ApiProperty({
    description: '模型总数',
    example: 1,
  })
  @Expose()
  total: number;
}
