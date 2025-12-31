import { IsString, IsNotEmpty, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRoleDto {
  @ApiProperty({ description: '角色名称', example: 'Admin' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: '权限配置',
    example: { user: ['read', 'write'], order: ['read'] },
  })
  @IsObject()
  permissions: Record<string, string[]>;
}

