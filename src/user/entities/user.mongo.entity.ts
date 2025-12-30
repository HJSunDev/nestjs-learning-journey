import { Entity, Column } from 'typeorm';
import { CommonMongoEntity } from '../../common/entities/common.mongo.entity';

@Entity('users') // 指定集合名称为 users
export class User extends CommonMongoEntity {
  @Column()
  name: string;

  @Column()
  email: string;

  @Column()
  password: string;
}

