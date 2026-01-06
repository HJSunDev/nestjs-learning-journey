import { Controller, Get, Post, Body, Patch, Param, Delete, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

@ApiTags('用户管理')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @ApiOperation({ summary: '创建新用户' })
  @ApiResponse({ status: 201, description: '用户创建成功', type: UserResponseDto })
  @Post()
  async create(@Body() createUserDto: CreateUserDto) {
    const user = await this.userService.create(createUserDto);
    // 转换为 DTO 返回，确保敏感字段被过滤
    return new UserResponseDto(user);
  }

  @ApiOperation({ summary: '获取所有用户列表 (分页)' })
  @ApiResponse({ status: 200, type: [UserResponseDto] })
  @Get()
  async findAll(@Query() query: PaginationQueryDto) {
    const result = await this.userService.findAll(query);
    return {
      data: plainToInstance(UserResponseDto, result.data), // 数组转换
      meta: result.meta,
    };
  }

  @ApiOperation({ summary: '根据ID获取用户详情' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const user = await this.userService.findOne(id);
    return new UserResponseDto(user);
  }

  @ApiOperation({ summary: '更新用户信息' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @Patch(':id')
  async update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    const user = await this.userService.update(id, updateUserDto);
    return new UserResponseDto(user);
  }

  @ApiOperation({ summary: '删除用户' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.userService.remove(id);
  }
}
