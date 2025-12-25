import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class HashingService {
  private readonly saltRounds = 10;

  /**
   * 对纯文本进行哈希处理
   * @param plainText 原始文本（如密码）
   * @returns 哈希后的字符串
   */
  async hash(plainText: string): Promise<string> {
    return bcrypt.hash(plainText, this.saltRounds);
  }

  /**
   * 比对纯文本与哈希值是否匹配
   * @param plainText 原始文本
   * @param hash 哈希值
   * @returns 是否匹配
   */
  async compare(plainText: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plainText, hash);
  }
}

