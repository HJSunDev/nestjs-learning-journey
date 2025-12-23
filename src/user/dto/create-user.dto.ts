import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({
    description: '用户邮箱',
    example: 'user@example.com',
  })
  email: string;

  @ApiProperty({
    description: '用户名称',
    example: 'John Doe',
  })
  username: string;

  @ApiProperty({
    description: '年龄',
    example: 25,
    required: false,
  })
  age?: number;
}
