import { Entity, Column } from 'typeorm';
import { ObjectId } from 'mongodb';
import { CommonMongoEntity } from '../../common/entities/common.mongo.entity';

@Entity('users') // 指定集合名称为 users
export class User extends CommonMongoEntity {
  @Column()
  name: string;

  @Column({ nullable: true })
  email?: string;

  @Column({ nullable: true })
  phoneNumber?: string;

  @Column()
  password: string;

  @Column()
  roleId?: ObjectId;

  // 存储 Refresh Token 的哈希值，用于验证和撤销
  // nullable: 用户登出后置空，表示无有效的 Refresh Token
  @Column({ nullable: true })
  currentHashedRefreshToken?: string;
}

