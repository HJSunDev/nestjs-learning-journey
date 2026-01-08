import {
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
} from 'typeorm';

/**
 * 通用实体基类
 * 提供所有实体共享的字段：UUID 主键、时间戳、软删除、乐观锁
 */
export abstract class CommonEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt: Date;

  /**
   * 乐观锁版本号
   * 每次更新操作(save/update)成功后，TypeORM 会自动 +1
   * 用于防止并发修改导致的 Lost Update 问题
   */
  @VersionColumn({ select: false })
  version: number;
}

