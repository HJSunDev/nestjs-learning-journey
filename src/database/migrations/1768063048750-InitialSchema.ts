import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 初始数据库结构迁移
 *
 * 创建核心业务表：
 * - roles: 角色表（RBAC 权限系统）
 * - users: 用户表（含外键关联 roles）
 *
 * 注意：类名中的时间戳是迁移系统的标识符，请勿修改
 */
export class Migration1768063048750 implements MigrationInterface {
  name = 'Migration1768063048750';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 确保 uuid-ossp 扩展已启用（用于生成 UUID）
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // 创建 roles 表
    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        "version" integer NOT NULL,
        "name" character varying NOT NULL,
        "permissions" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "UQ_648e3f5447f725579d7d4ffdfb7" UNIQUE ("name"),
        CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY ("id")
      )
    `);

    // 创建 users 表
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        "version" integer NOT NULL,
        "name" character varying NOT NULL,
        "email" character varying,
        "phoneNumber" character varying,
        "password" character varying NOT NULL,
        "role_id" uuid,
        "currentHashedRefreshToken" character varying,
        CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"),
        CONSTRAINT "UQ_1e3d0240b49c40521aaeb953293" UNIQUE ("phoneNumber"),
        CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")
      )
    `);

    // 添加外键约束：users.role_id -> roles.id
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD CONSTRAINT "FK_a2cecd1a3531c0b041e29ba46e1"
      FOREIGN KEY ("role_id") REFERENCES "roles"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_a2cecd1a3531c0b041e29ba46e1"`,
    );
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TABLE "roles"`);
  }
}
