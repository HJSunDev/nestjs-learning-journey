import { Entity, Column, ObjectId, ObjectIdColumn } from 'typeorm';

@Entity('users') // 指定集合名称为 users
export class User {
  @ObjectIdColumn()
  _id: ObjectId;

  @Column()
  name: string;

  @Column()
  email: string;

  @Column()
  password: string;

  @Column()
  createdAt: Date;

  @Column()
  updatedAt: Date;
}

