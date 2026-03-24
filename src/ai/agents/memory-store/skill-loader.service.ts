import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamicStructuredTool } from '@langchain/core/tools';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as z from 'zod';

import type {
  SkillMetadata,
  ParsedSkill,
  SkillCatalogEntry,
} from './skill-loader.types';

/**
 * 文件系统技能加载器 — 基于 Agent Skills 开放标准
 *
 * 遵循 Cursor / Claude Code / LangGraph 社区的生产级实践：
 * - 技能是文件系统中的 SKILL.md 文件，不是数据库记录
 * - YAML frontmatter 携带元数据，Markdown body 是完整指令
 * - 三层渐进式加载：Catalog → Full Content → Supporting Files
 *
 * 三层渐进式加载策略：
 * 1. Tier 1 — Catalog（始终注入系统提示词）：
 *    仅包含 name + description，~500 tokens，每次请求都携带
 * 2. Tier 2 — Full Content（按需 tool call）：
 *    Agent 调用 load_skill(name) 获取完整 SKILL.md 内容
 * 3. Tier 3 — Supporting Files（按需 tool call）：
 *    Agent 调用 read_skill_file(name, filename) 获取辅助资源
 *
 * 目录结构：
 * ```
 * src/ai/skills/
 *   code-review/
 *     SKILL.md              ← 必需：YAML frontmatter + Markdown 指令
 *     references/           ← 可选：辅助资源目录
 *       checklist.md
 *   nestjs-crud/
 *     SKILL.md
 * ```
 */
@Injectable()
export class SkillLoaderService implements OnModuleInit {
  private readonly logger = new Logger(SkillLoaderService.name);

  /** 元数据缓存（Tier 1 快速访问） */
  private readonly metadataCache = new Map<string, SkillMetadata>();

  /** 完整内容缓存（Tier 2 惰性加载） */
  private readonly contentCache = new Map<string, ParsedSkill>();

  private scanned = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.scan();
  }

  // ============================================================
  // Tier 1 — Catalog（轻量元数据，始终可用）
  // ============================================================

  /**
   * 扫描技能目录，解析所有 SKILL.md 的 YAML frontmatter
   *
   * 仅读取 frontmatter 部分（快速），不解析 Markdown body。
   * 启动时自动调用，也可手动调用刷新缓存。
   */
  async scan(): Promise<Map<string, SkillMetadata>> {
    // 获取技能根目录路径
    const skillsDir = this.getSkillsDir();

    // 清空元数据缓存
    this.metadataCache.clear();
    // 清空完整内容缓存
    this.contentCache.clear();

    try {
      // 检查技能根目录是否存在
      await fs.access(skillsDir);
    } catch {
      // 如果技能根目录不存在，则记录错误日志
      this.logger.warn(
        `技能目录不存在: ${skillsDir}，跳过技能扫描。` +
          '如需使用技能，请创建该目录并放入 SKILL.md 文件。',
      );
      // 设置扫描状态为已扫描
      this.scanned = true;
      return this.metadataCache;
    }

    try {
      // 读取技能根目录下的所有文件和目录
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        // 如果当前不是目录，则跳过
        if (!entry.isDirectory()) continue;

        // 拼接技能目录路径
        const skillDir = path.join(skillsDir, entry.name);
        // 拼接技能文件路径
        const skillFile = path.join(skillDir, 'SKILL.md');

        try {
          // 检查技能文件是否存在
          await fs.access(skillFile);
          // 读取技能文件内容
          const raw = await fs.readFile(skillFile, 'utf-8');
          // 解析技能文件的 YAML frontmatter
          const { metadata } = this.parseFrontmatter(raw);

          // 获取技能名称
          const skillName = (metadata.name as string) || entry.name;

          // 创建技能元数据对象，包含技能名称、描述、标签、SKILL.md 的完整路径、技能目录的完整路径
          const skillMetadata: SkillMetadata = {
            name: skillName,
            description: (metadata.description as string) || '',
            tags: Array.isArray(metadata.tags)
              ? (metadata.tags as string[])
              : [],
            filePath: skillFile,
            dirPath: skillDir,
          };

          // 缓存技能元数据
          this.metadataCache.set(skillName, skillMetadata);
        } catch {
          this.logger.warn(`跳过无效技能目录: ${entry.name}（缺少 SKILL.md）`);
        }
      }

      // 设置扫描状态为已扫描
      this.scanned = true;
      // 记录扫描完成日志
      this.logger.log(
        `技能扫描完成，发现 ${this.metadataCache.size} 个技能: ` +
          `[${[...this.metadataCache.keys()].join(', ')}]`,
      );
    } catch (error) {
      // 如果扫描失败，则记录错误日志
      this.logger.error(
        `技能目录扫描失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      // 设置扫描状态为已扫描
      this.scanned = true;
    }

    // 返回技能元数据缓存
    return this.metadataCache;
  }

  /**
   * 生成技能目录文本（注入系统提示词）
   *
   * 格式遵循 Agent Skills 标准的 XML 结构化目录：
   * ```xml
   * <skill>
   *   <name>code-review</name>
   *   <description>代码审查专家技能</description>
   *   <tags>code, review</tags>
   *   <supporting_files>references/checklist.md</supporting_files>
   * </skill>
   * ```
   */
  async getSkillCatalog(): Promise<string> {
    if (!this.scanned) {
      await this.scan();
    }

    if (this.metadataCache.size === 0) {
      return '';
    }

    // 创建技能目录文本
    const entries: string[] = [];

    for (const [, meta] of this.metadataCache) {
      // 获取技能的辅助资源文件列表
      const supportingFiles = await this.listSupportingFiles(meta.name);
      // 添加技能目录条目
      entries.push(
        '<skill>\n' +
          `  <name>${meta.name}</name>\n` +
          `  <description>${meta.description}</description>\n` +
          `  <tags>${meta.tags.join(', ')}</tags>\n` +
          (supportingFiles.length > 0
            ? `  <supporting_files>${supportingFiles.join(', ')}</supporting_files>\n`
            : '') +
          '</skill>',
      );
    }

    // 返回技能目录文本
    return entries.join('\n');
  }

  /**
   * 获取所有技能的目录条目列表（API 响应用）
   */
  async getCatalogEntries(): Promise<SkillCatalogEntry[]> {
    // 如果技能目录未扫描，则扫描技能目录
    if (!this.scanned) {
      await this.scan();
    }

    // 创建技能目录条目列表
    const entries: SkillCatalogEntry[] = [];

    for (const [, meta] of this.metadataCache) {
      // 获取技能的辅助资源文件列表
      const supportingFiles = await this.listSupportingFiles(meta.name);
      // 添加技能目录条目
      entries.push({
        name: meta.name,
        description: meta.description,
        tags: meta.tags,
        supportingFiles,
      });
    }

    return entries;
  }

  /**
   * 获取已发现的技能名称列表
   */
  getSkillNames(): string[] {
    return [...this.metadataCache.keys()];
  }

  // ============================================================
  // Tier 2 — Full Content（完整 SKILL.md 内容，按需加载）
  // ============================================================

  /**
   * 加载技能的完整内容（惰性加载 + 缓存）
   *
   * 首次访问时读取并解析完整 SKILL.md，后续从缓存返回。
   *
   * @param skillName - 技能名称
   * @returns 完整的 ParsedSkill，或 null（技能不存在）
   */
  async loadSkill(skillName: string): Promise<ParsedSkill | null> {
    // 如果缓存中存在技能，则直接返回缓存的技能
    if (this.contentCache.has(skillName)) {
      return this.contentCache.get(skillName)!;
    }

    // 获取技能的元数据
    const meta = this.metadataCache.get(skillName);
    // 如果技能不存在，则返回 null
    if (!meta) {
      return null;
    }

    try {
      // 读取技能的完整内容
      const raw = await fs.readFile(meta.filePath, 'utf-8');
      const { body } = this.parseFrontmatter(raw);
      // 获取技能的辅助资源文件列表
      const supportingFiles = await this.listSupportingFiles(skillName);
      // 创建 ParsedSkill 对象

      // 创建 ParsedSkill 对象
      const parsed: ParsedSkill = {
        // 技能元数据
        metadata: meta,
        // 技能指令体
        content: body,
        // 技能辅助资源文件列表
        supportingFiles,
      };

      // 缓存技能
      this.contentCache.set(skillName, parsed);
      // 返回 ParsedSkill 对象
      return parsed;
    } catch (error) {
      // 如果加载失败，则记录错误日志
      this.logger.error(
        `加载技能失败 [${skillName}]: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ============================================================
  // Tier 3 — Supporting Files（辅助资源，按需读取）
  // ============================================================

  /**
   * 列出技能目录下的辅助资源文件（排除 SKILL.md）
   *
   * @param skillName - 技能名称
   * @returns 相对于技能目录的文件路径列表
   */
  async listSupportingFiles(skillName: string): Promise<string[]> {
    // 获取技能的元数据
    const meta = this.metadataCache.get(skillName);
    // 如果技能不存在，则返回空数组
    if (!meta) return [];

    try {
      // 递归遍历技能目录下的所有辅助资源文件
      return await this.walkDir(meta.dirPath, meta.dirPath);
    } catch {
      // 如果遍历失败，则返回空数组
      return [];
    }
  }

  /**
   * 读取技能的辅助资源文件
   *
   * 包含路径遍历保护，防止读取技能目录之外的文件。
   *
   * @param skillName - 技能名称
   * @param filename - 相对于技能目录的文件路径
   * @returns 文件内容，或 null（文件不存在/路径非法）
   */
  async readSupportingFile(
    skillName: string,
    filename: string,
  ): Promise<string | null> {
    const meta = this.metadataCache.get(skillName);
    if (!meta) return null;

    const resolvedPath = path.resolve(meta.dirPath, filename);

    // 路径遍历保护：确保解析后的路径在技能目录内
    if (!resolvedPath.startsWith(meta.dirPath)) {
      this.logger.warn(
        `路径遍历攻击被阻止: skill=${skillName}, filename=${filename}`,
      );
      return null;
    }

    // 不允许读取 SKILL.md（应通过 loadSkill 获取）
    if (path.basename(resolvedPath) === 'SKILL.md') {
      return null;
    }

    try {
      return await fs.readFile(resolvedPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ============================================================
  // LangGraph 工具创建
  // ============================================================

  /**
   * 创建技能相关的 LangGraph 工具
   *
   * 返回两个工具供 Agent 在 ReAct 循环中调用：
   * 1. load_skill — 加载技能的完整指令（Tier 2）
   * 2. read_skill_file — 读取技能的辅助资源文件（Tier 3）
   *
   * 工具的 description 中动态注入可用技能列表，
   * 帮助模型准确选择技能名称。
   */
  createSkillTools(): DynamicStructuredTool[] {
    // 获取所有技能名称列表
    const skillNames = this.getSkillNames();
    // 如果技能名称列表不为空，则将技能名称列表拼接成字符串
    // 否则返回 'none'
    const availableList =
      skillNames.length > 0 ? skillNames.join(', ') : 'none';
    // 创建 load_skill 工具

    // 创建 load_skill 工具，用于加载技能的完整内容
    const loadSkillTool = new DynamicStructuredTool({
      // 工具名称
      name: 'load_skill',
      // 工具描述
      description:
        'Load expert knowledge for a specific skill. Returns the full ' +
        'instructions and a list of supporting files. ' +
        `Available skills: ${availableList}`,
      // 工具参数 schema
      schema: z.object({
        // 技能名称
        skill_name: z.string().describe('Exact name of the skill to load'),
      }),
      func: async ({ skill_name }) => {
        // 加载技能
        const parsed = await this.loadSkill(skill_name);
        // 如果技能不存在，则返回错误信息
        if (!parsed) {
          return JSON.stringify({
            error: `Skill '${skill_name}' not found`,
            available_skills: availableList,
          });
        }
        // 返回技能的完整内容
        return JSON.stringify({
          skill_name,
          description: parsed.metadata.description,
          instructions: parsed.content,
          // 技能的辅助资源文件列表
          available_files: parsed.supportingFiles,
        });
      },
    });

    // 创建 read_skill_file 工具，用于读取技能的辅助资源文件
    const readSkillFileTool = new DynamicStructuredTool({
      // 工具名称
      name: 'read_skill_file',
      // 工具描述
      description:
        'Read a supporting file from a skill folder. ' +
        'Use this after load_skill to get additional reference material.',
      // 工具参数 schema
      schema: z.object({
        // 技能名称
        skill_name: z
          .string()
          .describe('Name of the skill the file belongs to'),
        // 文件路径
        filename: z
          .string()
          .describe('Relative path to the file within the skill folder'),
      }),
      func: async ({ skill_name, filename }) => {
        // 读取技能的辅助资源文件
        const content = await this.readSupportingFile(skill_name, filename);
        // 如果文件不存在，则返回错误信息
        if (content === null) {
          return JSON.stringify({
            error: `File '${filename}' not found in skill '${skill_name}'`,
          });
        }
        return JSON.stringify({ skill_name, filename, content });
      },
    });

    return [loadSkillTool, readSkillFileTool];
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 获取技能根目录路径
   */
  private getSkillsDir(): string {
    // 获取技能根目录路径配置
    const configured = this.configService.get<string>('ai.skills.dir');
    // 如果配置了技能根目录路径，则使用配置的目录路径
    if (configured) {
      return path.resolve(configured);
    }
    // 如果未配置技能根目录路径，则使用默认的目录路径
    return path.resolve(process.cwd(), 'src', 'ai', 'skills');
  }

  /**
   * 解析 SKILL.md 的 YAML frontmatter
   *
   * YAML frontmatter 是 Markdown 文件开头用 `---` 包裹的元数据块，
   * 用于存储结构化的元信息（如标题、作者、标签等），是 Jekyll、Hugo、
   * Obsidian 等工具的标准格式。
   *
   * 输入示例：
   * ```markdown
   * ---
   * name: code-review
   * description: "代码审查专家技能，关注安全性、性能和代码规范"
   * tags: [code, review, quality]
   * ---
   *
   * ## Code Review Guidelines
   * （Markdown 正文内容）
   * ```
   *
   * 输出：
   * ```typescript
   * {
   *   metadata: {
   *     name: 'code-review',
   *     description: '代码审查专家技能，关注安全性、性能和代码规范',
   *     tags: ['code', 'review', 'quality']
   *   },
   *   body: '## Code Review Guidelines\n（Markdown 正文内容）'
   * }
   * ```
   *
   * 实现细节：
   * - 不引入额外依赖（如 gray-matter），使用正则匹配 frontmatter 块
   * - 手动解析有限的 YAML 字段（name、description、tags）
   * - 支持字符串值（带引号或不带引号）和数组值（[item1, item2]）
   * - 忽略注释行（以 # 开头）和空行
   * - 对于我们约束的 SKILL.md 格式已经足够
   *
   * @param raw - SKILL.md 文件的原始内容
   * @returns 包含元数据对象和正文字符串的对象
   */
  private parseFrontmatter(raw: string): {
    metadata: Record<string, unknown>;
    body: string;
  } {
    const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
    const match = raw.match(fmRegex);

    if (!match) {
      return { metadata: {}, body: raw.trim() };
    }

    const yamlBlock = match[1];
    const body = (match[2] || '').trim();
    const metadata: Record<string, unknown> = {};

    for (const line of yamlBlock.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.+)$/);
      if (!kvMatch) continue;

      const [, key, rawValue] = kvMatch;
      const value = rawValue.trim();

      // 数组语法: [tag1, tag2, "tag 3"]
      if (value.startsWith('[') && value.endsWith(']')) {
        metadata[key] = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      } else {
        // 字符串值（去除引号）
        metadata[key] = value.replace(/^['"]|['"]$/g, '');
      }
    }

    return { metadata, body };
  }

  /**
   * 递归遍历目录，收集所有辅助资源文件的相对路径（排除 SKILL.md）
   *
   * 收集的文件类型（Supporting Files - Tier 3）：
   * - 参考文档：references/checklist.md、references/security-guide.md
   * - 示例代码：examples/good-code.ts、examples/bad-code.ts
   * - 模板文件：templates/review-template.md
   * - 配置文件：configs/eslint-rules.json
   *
   * 这些文件不会在初始加载时读取，而是由 Agent 通过 read_skill_file 工具按需读取，
   * 实现三层渐进式加载策略中的 Tier 3 层级，避免一次性加载所有内容浪费 token。
   *
   * 示例：
   * 技能目录结构：
   * ```
   * src/ai/skills/code-review/
   *   SKILL.md                    ← 排除（通过 loadSkill 加载）
   *   references/
   *     checklist.md              ← 收集：references/checklist.md
   *     security-guide.md         ← 收集：references/security-guide.md
   *   examples/
   *     good-code.ts              ← 收集：examples/good-code.ts
   * ```
   *
   * 返回：['references/checklist.md', 'references/security-guide.md', 'examples/good-code.ts']
   *
   * @param dir - 当前遍历的目录路径
   * @param baseDir - 技能根目录路径
   * @returns 相对于技能根目录的文件路径列表（使用正斜杠，跨平台兼容）
   */
  private async walkDir(dir: string, baseDir: string): Promise<string[]> {
    // 文件路径列表
    const files: string[] = [];

    try {
      // 读取当前目录下的所有文件和目录
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        // 拼接当前文件或目录的完整路径
        const fullPath = path.join(dir, entry.name);

        // 如果当前是目录，则递归遍历子目录
        if (entry.isDirectory()) {
          // 递归遍历子目录
          const subFiles = await this.walkDir(fullPath, baseDir);
          files.push(...subFiles);
        } else if (entry.name !== 'SKILL.md') {
          // 如果当前是文件，则添加到文件路径列表
          // 使用 path.relative 获取相对于技能根目录的相对路径
          // 使用正斜杠，跨平台兼容
          files.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
        }
      }
    } catch {
      // 目录读取失败时返回空列表
    }

    return files;
  }
}
