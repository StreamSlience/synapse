import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * LiquidExtractor - 从 Liquid 模板文件中提取关系
 *
 * Liquid 是一种模板语言（被 Shopify、Jekyll 等使用），没有传统意义上的
 * 函数或类。我们提取的内容包括：
 * - Section 引用（{% section 'name' %}）
 * - Snippet 引用（{% render 'name' %} 和 {% include 'name' %}）
 * - Schema 块（{% schema %}...{% endschema %}）
 */
export class LiquidExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  /**
   * 从 Liquid 源码中提取内容
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // 创建文件节点
      const fileNode = this.createFileNode();

      // Shopify OS 2.0 JSON 模板 / section group：将每个 section 的 `type`
      // 关联到其对应的 `sections/<type>.liquid` 文件。（不生成符号节点——
      // JSON 文件仅承载引用——因此不计入任何符号承载文件指标，
      // 但其 section 仍能获得依赖方。）
      if (this.filePath.endsWith('.json')) {
        this.extractShopifyJsonSections(fileNode.id);
      } else {
        // 提取 render/include 语句（snippet 引用）
        this.extractSnippetReferences(fileNode.id);

        // 提取 section 引用
        this.extractSectionReferences(fileNode.id);

        // 提取 schema 块
        this.extractSchema(fileNode.id);

        // 提取 assign 语句作为变量
        this.extractAssignments(fileNode.id);
      }
    } catch (error) {
      this.errors.push({
        message: `Liquid extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 为 Liquid 模板创建文件节点
   */
  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);

    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'liquid',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };

    this.nodes.push(fileNode);
    return fileNode;
  }

  /**
   * Shopify OS 2.0 JSON 模板 / section group。两者都有一个 `sections` 对象，
   * 将 id 映射到 `{ "type": "<section-name>", ... }`；`type` 指向
   * `sections/<type>.liquid` 文件。为每个文件生成一条 `references` 边，
   * 这样仅从 JSON 模板引用的 section（OS 2.0 的规范做法）就不再是孤儿节点。
   */
  private extractShopifyJsonSections(fromNodeId: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.source);
    } catch {
      return; // 无效 JSON（或不完整）——没有可关联的内容
    }
    const sections = (parsed as { sections?: Record<string, { type?: unknown }> })?.sections;
    if (!sections || typeof sections !== 'object') return;
    const seen = new Set<string>();
    for (const key of Object.keys(sections)) {
      const type = sections[key]?.type;
      if (typeof type !== 'string' || seen.has(type)) continue;
      seen.add(type);
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: `sections/${type}.liquid`,
        referenceKind: 'references',
        line: 1,
        column: 0,
      });
    }
  }

  /**
   * 提取 {% render 'snippet' %} 和 {% include 'snippet' %} 引用
   */
  private extractSnippetReferences(fileNodeId: string): void {
    // 匹配 {% render 'name' %} 或 {% include 'name' %}，可带可选参数
    const renderRegex = /\{%[-]?\s*(render|include)\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = renderRegex.exec(this.source)) !== null) {
      const [fullMatch, tagType, snippetName] = match;
      const line = this.getLineNumber(match.index);

      // 创建导入节点以便搜索
      const importNodeId = generateNodeId(this.filePath, 'import', snippetName!, line);
      const importNode: Node = {
        id: importNodeId,
        kind: 'import',
        name: snippetName!,
        qualifiedName: `${this.filePath}::import:${snippetName}`,
        filePath: this.filePath,
        language: 'liquid',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(importNode);

      // 添加从文件到导入节点的包含边
      this.edges.push({
        source: fileNodeId,
        target: importNodeId,
        kind: 'contains',
      });

      // 为 snippet 引用创建组件节点
      const nodeId = generateNodeId(this.filePath, 'component', `${tagType}:${snippetName}`, line);

      const node: Node = {
        id: nodeId,
        kind: 'component',
        name: snippetName!,
        qualifiedName: `${this.filePath}::${tagType}:${snippetName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // 添加从文件出发的包含边
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });

      // 添加到 snippet 文件的未解析引用
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `snippets/${snippetName}.liquid`,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }

  /**
   * 提取 {% section 'name' %} 引用
   */
  private extractSectionReferences(fileNodeId: string): void {
    // 匹配 {% section 'name' %}
    const sectionRegex = /\{%[-]?\s*section\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = sectionRegex.exec(this.source)) !== null) {
      const [fullMatch, sectionName] = match;
      const line = this.getLineNumber(match.index);

      // 创建导入节点以便搜索
      const importNodeId = generateNodeId(this.filePath, 'import', sectionName!, line);
      const importNode: Node = {
        id: importNodeId,
        kind: 'import',
        name: sectionName!,
        qualifiedName: `${this.filePath}::import:${sectionName}`,
        filePath: this.filePath,
        language: 'liquid',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(importNode);

      // 添加从文件到导入节点的包含边
      this.edges.push({
        source: fileNodeId,
        target: importNodeId,
        kind: 'contains',
      });

      // 为 section 引用创建组件节点
      const nodeId = generateNodeId(this.filePath, 'component', `section:${sectionName}`, line);

      const node: Node = {
        id: nodeId,
        kind: 'component',
        name: sectionName!,
        qualifiedName: `${this.filePath}::section:${sectionName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // 添加从文件出发的包含边
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });

      // 添加到 section 文件的未解析引用
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `sections/${sectionName}.liquid`,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }

  /**
   * 提取 {% schema %}...{% endschema %} 块
   */
  private extractSchema(fileNodeId: string): void {
    // 匹配 {% schema %}...{% endschema %}
    const schemaRegex = /\{%[-]?\s*schema\s*[-]?%\}([\s\S]*?)\{%[-]?\s*endschema\s*[-]?%\}/g;
    let match;

    while ((match = schemaRegex.exec(this.source)) !== null) {
      const [fullMatch, schemaContent] = match;
      const startLine = this.getLineNumber(match.index);
      const endLine = this.getLineNumber(match.index + fullMatch.length);

      // 尝试解析 schema JSON 以获取名称
      let schemaName = 'schema';
      try {
        const schemaJson = JSON.parse(schemaContent!);
        if (schemaJson.name) {
          // Shopify schema 名称可以是翻译对象，如 {"en": "...", "fr": "..."}
          schemaName = typeof schemaJson.name === 'string'
            ? schemaJson.name
            : schemaJson.name.en || Object.values(schemaJson.name)[0] as string || 'schema';
        }
      } catch {
        // schema 不是有效 JSON，使用默认名称
      }

      // 为 schema 创建节点
      const nodeId = generateNodeId(this.filePath, 'constant', `schema:${schemaName}`, startLine);

      const node: Node = {
        id: nodeId,
        kind: 'constant',
        name: schemaName,
        qualifiedName: `${this.filePath}::schema:${schemaName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine,
        endLine,
        startColumn: match.index - this.getLineStart(startLine),
        endColumn: 0,
        // 安全性（#383）：不将原始 {% schema %} JSON（section 设置及默认值）
        // 写入 docstring——schema 名称已在 `name` 字段中，数据块除了
        // 可能泄露开发者放在设置默认值中的 ID/端点/密钥外毫无价值。
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // 添加从文件出发的包含边
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });
    }
  }

  /**
   * 提取 {% assign var = value %} 语句
   */
  private extractAssignments(fileNodeId: string): void {
    // 匹配 {% assign variable_name = ... %}
    const assignRegex = /\{%[-]?\s*assign\s+(\w+)\s*=/g;
    let match;

    while ((match = assignRegex.exec(this.source)) !== null) {
      const [, variableName] = match;
      const line = this.getLineNumber(match.index);

      // 创建变量节点
      const nodeId = generateNodeId(this.filePath, 'variable', variableName!, line);

      const node: Node = {
        id: nodeId,
        kind: 'variable',
        name: variableName!,
        qualifiedName: `${this.filePath}::${variableName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + match[0].length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // 添加从文件出发的包含边
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });
    }
  }

  /**
   * 根据字符索引获取行号
   */
  private getLineNumber(index: number): number {
    const substring = this.source.substring(0, index);
    return (substring.match(/\n/g) || []).length + 1;
  }

  /**
   * 获取指定行起始处的字符索引
   */
  private getLineStart(lineNumber: number): number {
    const lines = this.source.split('\n');
    let index = 0;
    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
      index += lines[i]!.length + 1; // +1 对应换行符
    }
    return index;
  }
}
