import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose, Transform } from 'class-transformer';
import { ObjectId } from 'mongodb';

/**
 * 用户响应 DTO
 * 职责：定义返回给客户端的用户数据结构，自动剔除敏感信息。
 */
@Exclude() // 关键：默认排除所有字段，只有 @Expose 的才返回
export class UserResponseDto {

  @ApiProperty({ description: '用户ID', example: '65a0c...' })
  @Expose() // 显式暴露
  // 自动将 ObjectId 转为字符串，方便前端使用
  @Transform(({ value }) => value?.toString(), { toPlainOnly: true }) 
  _id: ObjectId;

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

