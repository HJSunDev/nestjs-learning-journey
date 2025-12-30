import {
  ObjectIdColumn,
  ObjectId,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
} from 'typeorm';

export abstract class CommonMongoEntity {
  @ObjectIdColumn()
  _id: ObjectId;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamp' })
  deletedAt: Date;

  /**
   * 乐观锁版本号
   * 每次更新操作(save/update)成功后，TypeORM 会自动 +1
   * 用于防止并发修改导致的 Lost Update 问题
   */
  @VersionColumn({ select: false })
  version: number;
}

