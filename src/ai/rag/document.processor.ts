import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Document } from '@langchain/core/documents';

/**
 * 文档切块选项
 */
export interface SplitOptions {
  /** 切块大小（字符数），覆盖默认配置 */
  chunkSize?: number;
  /** 相邻块重叠区域（字符数），覆盖默认配置 */
  chunkOverlap?: number;
}

/**
 * 文档处理器
 *
 * 负责 RAG 数据摄入管线的文档预处理环节：
 * 将原始文本切分为语义完整的小块（chunk），每个 chunk 作为独立的向量化单元。
 *
 * 为什么需要切块？
 * - Embedding 模型有 token 上限（Qwen3-Embedding-8B 为 32K）
 * - 更短的文本块产生更精确的向量表示，检索准确率更高
 * - 切块后的文档可以精确定位到用户问题的相关段落
 *
 * 切块策略：RecursiveCharacterTextSplitter
 * - 按 段落(\n\n) → 换行(\n) → 句子(。！？) → 空格 → 单字 的层级递归切分
 * - 在不超过 chunkSize 的前提下，尽量保留最大的语义单元
 * - chunkOverlap 在相邻块之间创建重叠区域，防止跨块信息丢失
 */
@Injectable()
export class DocumentProcessor {
  private readonly logger = new Logger(DocumentProcessor.name);
  private readonly defaultChunkSize: number;
  private readonly defaultChunkOverlap: number;

  constructor(private readonly configService: ConfigService) {
    this.defaultChunkSize = this.configService.get<number>(
      'ai.rag.splitter.chunkSize',
      500,
    );
    this.defaultChunkOverlap = this.configService.get<number>(
      'ai.rag.splitter.chunkOverlap',
      50,
    );
  }

  /**
   * 将纯文本切分为 Document 数组
   *
   * 每个 Document 包含 pageContent（文本块）和 metadata（来源信息）。
   * metadata 中自动注入 source（来源标识）和 chunkIndex（块序号）。
   *
   * @param text 原始文本
   * @param metadata 附加的元数据（如文件名、URL 等）
   * @param options 切块参数覆盖
   * @returns LangChain Document 数组
   */
  async splitText(
    text: string,
    metadata: Record<string, unknown> = {},
    options?: SplitOptions,
  ): Promise<Document[]> {
    const splitter = this.createSplitter(options);

    const docs = await splitter.createDocuments([text], [metadata]);

    this.logger.debug(
      `文本切块完成 [原始长度=${text.length}, 块数=${docs.length}, ` +
        `chunkSize=${options?.chunkSize || this.defaultChunkSize}]`,
    );

    return docs.map(
      (doc, index) =>
        new Document({
          pageContent: doc.pageContent,
          metadata: {
            ...doc.metadata,
            chunkIndex: index,
          },
        }),
    );
  }

  /**
   * 将多段文本批量切分
   *
   * 每段文本独立切分后合并返回，metadata 中保留各自的 source 标识。
   *
   * @param items 文本条目数组，每项包含文本内容和元数据
   * @param options 切块参数覆盖
   * @returns 合并后的 Document 数组
   */
  async splitMany(
    items: { text: string; metadata?: Record<string, unknown> }[],
    options?: SplitOptions,
  ): Promise<Document[]> {
    const allDocs: Document[] = [];

    for (const item of items) {
      const docs = await this.splitText(
        item.text,
        item.metadata || {},
        options,
      );
      allDocs.push(...docs);
    }

    this.logger.log(
      `批量切块完成 [文档数=${items.length}, 总块数=${allDocs.length}]`,
    );

    return allDocs;
  }

  private createSplitter(
    options?: SplitOptions,
  ): RecursiveCharacterTextSplitter {
    return new RecursiveCharacterTextSplitter({
      chunkSize: options?.chunkSize || this.defaultChunkSize,
      chunkOverlap: options?.chunkOverlap || this.defaultChunkOverlap,
      separators: ['\n\n', '\n', '。', '！', '？', '.', '!', '?', ' ', ''],
    });
  }
}
