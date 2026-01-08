import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { CommonEntity } from '../../common/entities/common.entity';
import { Role } from '../../role/entities/role.entity';

@Entity('users')
export class User extends CommonEntity {
  @Column()
  name: string;

  @Column({ nullable: true, unique: true })
  email?: string;

  @Column({ nullable: true, unique: true })
  phoneNumber?: string;

  @Column()
  password: string;

  /**
   * 用户角色关联
   * 使用 ManyToOne 关系替代原来的 ObjectId 字符串引用
   * 实现真正的外键约束，数据库层面保证数据一致性
   */
  @ManyToOne(() => Role, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  /**
   * 角色 ID 字段（可选，用于直接访问外键值）
   * 当只需要 roleId 而不需要加载完整 Role 对象时使用
   */
  @Column({ name: 'role_id', nullable: true })
  roleId?: string;

  /**
   * 存储 Refresh Token 的哈希值，用于验证和撤销
   * nullable: 用户登出后置空，表示无有效的 Refresh Token
   */
  @Column({ nullable: true })
  currentHashedRefreshToken?: string;
}

