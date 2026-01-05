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
}

