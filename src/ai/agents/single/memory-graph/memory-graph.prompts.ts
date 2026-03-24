/**
 * Memory-aware Agent 提示词模板
 *
 * 系统提示词分为多段拼接：
 * 1. 基础角色指令
 * 2. 记忆上下文（由 loadMemories 节点从 Store 动态注入）
 * 3. 技能系统指令 + 技能目录（由 loadMemories 节点从文件系统注入）
 * 4. 记忆提取协议（引导模型在回复中提取新记忆）
 */

/**
 * 记忆提取协议
 * 在对话结束时，分析对话内容，提取值得记忆的信息。
 * 如果识别到以下信息，则输出到 <memory_extract> 标签中：
 * 1. 语义记忆（事实、偏好、个人信息）
 * 2. 情景记忆（对话总结）
 * 3. 程序记忆（学习的过程）
 * 格式为 JSON 数组，只包含需要提取的记忆。
 * 如果不需要提取记忆，则不输出 <memory_extract> 标签。
 *
 * 格式为：
 * <memory_extract>
 * [
 *   { "type": "semantic", "content": "用户偏好暗色主题和 Vim 快捷键" },
 *   { "type": "episodic", "content": "讨论了从 MongoDB 迁移到 PostgreSQL 的方案" }
 * ]
 *
 * </memory_extract>
 * 注入到系统提示词末尾，引导模型在回复后输出结构化的记忆提取结果。
 * 模型看到此指令后会在回复中包含 <memory_extract> 标签。
 */
export const MEMORY_EXTRACTION_INSTRUCTION = `
## Memory Extraction Protocol

After responding to the user, analyze the conversation for information worth remembering.
If you identify any of the following, output them in a <memory_extract> block:

1. **Semantic memories** (facts, preferences, personal info):
   - User's name, role, preferences, constraints
   - Technical stack, tools they use
   - Preferences about communication style

2. **Episodic memories** (conversation summaries):
   - Key decisions made in this conversation
   - Important context that should carry over

3. **Procedural memories** (learned procedures):
   - Workflows or processes the user described
   - Step-by-step instructions for tasks

Format (JSON array, only include if there are memories to extract):
<memory_extract>
[
  { "type": "semantic", "content": "User prefers dark mode and uses TypeScript" },
  { "type": "episodic", "content": "Discussed migration from MongoDB to PostgreSQL, decided to use TypeORM" }
]
</memory_extract>

If no new information worth remembering, do NOT output the <memory_extract> block.
`.trim();

/**
 * 给AI的技能系统说明
 * 遵循 Agent Skills 开放标准的三层渐进式加载模式：
 * - Tier 1: 技能目录始终注入系统提示词（轻量，~500 tokens）
 * - Tier 2: Agent 通过 load_skill() tool call 按需加载完整技能指令
 * - Tier 3: Agent 通过 read_skill_file() tool call 按需读取辅助资源文件
 */
const SKILL_SYSTEM_INSTRUCTION = `
## Skills System

You have access to a skills system that provides domain expertise.

### What are Skills?

Skills are packages of domain expertise stored as Markdown files. Each skill contains:
- **Instructions**: Detailed guidance on when and how to apply the skill
- **Supporting files**: Reference documentation, checklists, and examples

### How to Use Skills

**Skill names are NOT callable functions.** You MUST use the skill tools:
1. \`load_skill(skill_name)\` — Load the full instructions for a skill
2. \`read_skill_file(skill_name, filename)\` — Read a specific supporting file

### Progressive Discovery Workflow

1. **Browse**: Review the skill catalog below
2. **Match**: When a task aligns with a skill's description, load it first
3. **Load**: Call \`load_skill(skill_name)\` to get detailed instructions
4. **Inspect**: Check \`available_files\` in the response
5. **Reference**: Use \`read_skill_file\` for specific documentation as needed
6. **Execute**: Apply the skill's guidance to complete the user's task

### Guidelines

- For general conversation, respond directly without loading skills
- For domain-specific tasks that match a skill's description, load the relevant skill first
`.trim();

/**
 * 构建带记忆上下文的系统提示词
 *
 * @param basePrompt - 基础系统提示词
 * @param memories - 检索到的相关记忆文本列表
 * @param skillCatalog - 技能目录, XML 文本（由 SkillLoaderService 生成）
 * @param enableSkillLoading - 是否包含技能系统指令和目录
 * @param enableExtraction - 是否追加记忆提取指令
 * @returns 完整的系统提示词
 */
export function buildMemorySystemPrompt(
  // 基础系统提示词
  basePrompt: string,
  // 检索到的记忆文本列表
  memories: string[],
  // 技能目录
  skillCatalog: string,
  // 是否启用技能加载
  enableSkillLoading: boolean,
  // 是否追加记忆提取指令
  enableExtraction: boolean,
): string {
  const parts: string[] = [basePrompt || 'You are a helpful assistant.'];

  // 如果检索到的记忆不为空，则追加记忆上下文
  if (memories.length > 0) {
    parts.push(
      '## Known Information About This User\n' +
        'The following are previously stored memories about this user. ' +
        'Use them to personalize your responses:\n\n' +
        memories.map((m, i) => `${i + 1}. ${m}`).join('\n'),
    );
  }

  // 如果启用技能加载，则追加技能系统指令和目录
  if (enableSkillLoading && skillCatalog) {
    parts.push(
      SKILL_SYSTEM_INSTRUCTION + '\n\n### Available Skills\n\n' + skillCatalog,
    );
  }

  // 如果启用提取功能，则追加记忆提取指令
  if (enableExtraction) {
    parts.push(MEMORY_EXTRACTION_INSTRUCTION);
  }

  return parts.join('\n\n');
}
