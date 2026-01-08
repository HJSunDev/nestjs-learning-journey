import { Entity, Column } from 'typeorm';
import { CommonEntity } from '../../common/entities/common.entity';

@Entity('roles')
export class Role extends CommonEntity {
  @Column({ unique: true })
  name: string;

  /**
   * 权限配置
   * 格式: { [resource: string]: Action[] }
   * 示例:
   * {
   *   "user": ["read", "write"],
   *   "order": ["read"]
   * }
   * 
   * 使用 PostgreSQL jsonb 类型，支持索引和复杂查询
   */
  @Column({ type: 'jsonb', default: {} })
  permissions: Record<string, string[]>;
}

