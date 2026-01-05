import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, Matches, IsString } from 'class-validator';
import { regMobileCN } from '../../common/utils/regex.util';

export class LoginDTO {
  @Matches(regMobileCN, { message: '请输入正确手机号' })
  @IsNotEmpty({ message: '请输入手机号' })
  @ApiProperty({ example: '13611177421' })
  readonly phoneNumber: string;

  @IsNotEmpty({ message: '请输入密码' })
  @ApiProperty({ example: '888888' })
  readonly password: string;
}

export class RegisterDTO {
  /**
   * 手机号，唯一
   */
  @Matches(regMobileCN, { message: '请输入正确手机号' })
  @IsNotEmpty({ message: '请输入手机号' })
  @ApiProperty({ example: '13611177421' })
  readonly phoneNumber: string;

  /**
   * 用户名
   */
  @IsNotEmpty({ message: '请输入用户昵称' })
  @IsString({ message: '名字必须是 String 类型' })
  @ApiProperty({ example: "admin" })
  readonly name: string;

  /**
   * 用户密码
   */
  @IsNotEmpty({ message: '请输入密码' })
  @ApiProperty({ example: '888888' })
  readonly password: string;

  /**
   * 二次输入密码
   */
  @IsNotEmpty({ message: '请再次输入密码' })
  @ApiProperty({ example: '888888' })
  readonly passwordRepeat: string
}

export class UserInfoDto {
  @ApiProperty({ example: '13611177421' })
  phoneNumber: string;

  @ApiProperty({ example: 'admin' })
  name: string;

  @ApiProperty({ example: '123456' })
  id: string;

  // 更多字段可以根据 User 实体扩展
  @ApiProperty({ example: '2024-01-01' })
  createdAt: Date;
}


