import { Entity, Column } from 'typeorm';
import { CommonMongoEntity } from '../../common/entities/common.mongo.entity';

@Entity('roles')
export class Role extends CommonMongoEntity {
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
   */
  @Column()
  permissions: Record<string, string[]>;
}

