import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';

/**
 * 用户响应 DTO
 * 职责：定义返回给客户端的用户数据结构，自动剔除敏感信息。
 */
@Exclude() // 默认排除所有字段，只有 @Expose 的才返回
export class UserResponseDto {

  @ApiProperty({ description: '用户ID', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @Expose()
  id: string;

  @ApiProperty({ description: '用户昵称' })
  @Expose()
  name: string;

  @ApiProperty({ description: '手机号' })
  @Expose()
  phoneNumber: string;

  @ApiProperty({ description: '创建时间' })
  @Expose()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @Expose()
  updatedAt: Date;

  // 这里的 constructor 允许我们方便地 new UserResponseDto(userEntity)
  constructor(partial: Partial<UserResponseDto>) {
    Object.assign(this, partial);
  }
}

