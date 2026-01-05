import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsInt, Min, MinLength, IsOptional, Matches, MaxLength, IsNotEmpty, Length } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({
    description: '用户邮箱',
    example: 'user@example.com',
    required: false,
  })
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string;

  @ApiProperty({
    description: '用户密码',
    example: 'password123',
    minLength: 6,
    maxLength: 20,
  })
  @IsNotEmpty({ message: '密码不能为空' })
  @IsString()
  @Length(6, 20, { message: '密码长度必须在 6 到 20 个字符之间' })
  password: string;

  @ApiProperty({
    description: '用户名称',
    example: 'John Doe',
  })
  @IsString()
  @MinLength(2, { message: '用户名至少包含 2 个字符' })
  @MaxLength(20, { message: '用户名最多包含 20 个字符' })
  name: string;

  @ApiProperty({
    description: '手机号码',
    example: '13800138000',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号码格式不正确' })
  phoneNumber?: string;

  @ApiProperty({
    description: '年龄',
    example: 25,
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '年龄必须是整数' })
  @Min(0, { message: '年龄不能小于 0' })
  age?: number;
}
