/**
 * 文件系统技能加载器类型定义
 *
 * 遵循 Agent Skills 开放标准 (https://agentskills.io/)
 * 与 Cursor Skills、Claude Code Skills 的设计保持一致：
 * - 技能是文件系统中的 Markdown 文件，不是数据库记录
 * - YAML frontmatter 携带元数据（name、description、tags）
 * - Markdown body 是完整的技能指令
 * - 三层渐进式加载：目录 → 完整指令 → 辅助资源文件
 */

/**
 * SKILL.md 中 YAML frontmatter 解析出的元数据
 *
 * 对应文件格式：
 * ```yaml
 * ---
 * name: code-review
 * description: "代码审查专家技能"
 * tags: [code, review]
 * ---
 * ```
 */
export interface SkillMetadata {
  /** 技能标识（小写字母、数字、连字符，必须与目录名一致） */
  name: string;
  /** 技能描述（Agent 根据此字段判断是否需要加载该技能） */
  description: string;
  /** 分类标签 */
  tags: string[];
  /** SKILL.md 文件的绝对路径（运行时填充） */
  filePath: string;
  /** 技能目录的绝对路径（运行时填充，用于读取辅助文件） */
  dirPath: string;
}

/**
 * 完整解析后的技能（元数据 + 指令体）
 *
 * Tier 2 加载时返回此结构
 */
export interface ParsedSkill {
  metadata: SkillMetadata;
  /** Markdown 指令体（frontmatter 之后的全部内容） */
  content: string;
  /** 该技能目录下的辅助资源文件列表（相对路径） */
  supportingFiles: string[];
}

/**
 * 技能目录条目（Tier 1 目录展示用）
 *
 * 仅包含轻量元数据，用于生成技能目录注入系统提示词
 */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  tags: string[];
  supportingFiles: string[];
}
