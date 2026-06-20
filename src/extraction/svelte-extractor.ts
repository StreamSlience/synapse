import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

/** Svelte 5 rune 名称——编译器内置，不是真正的函数 */
const SVELTE_RUNES = new Set([
  '$props', '$state', '$derived', '$effect', '$bindable',
  '$inspect', '$host', '$snippet',
]);

/**
 * SvelteExtractor——从 Svelte 组件文件中提取代码关系
 *
 * Svelte 文件是多语言的（script + template + style）。我们不解析完整的
 * Svelte grammar，而是提取 <script> 块内容并委托给 TypeScript/JavaScript
 * TreeSitterExtractor 处理。
 *
 * 同时从模板表达式（`{fn(...)}`）中提取函数调用，以便在调用位于标记中时
 * 也能捕获跨文件调用边。
 *
 * 每个 .svelte 文件都会生成一个组件节点（Svelte 组件总是可导入的）。
 */
export class SvelteExtractor {
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
   * 从 Svelte 源码中提取
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // 为 .svelte 文件本身创建组件节点
      const componentNode = this.createComponentNode();

      // 提取并处理 script 块
      const scriptBlocks = this.extractScriptBlocks();

      for (const block of scriptBlocks) {
        this.processScriptBlock(block, componentNode.id);
      }

      // 从模板表达式（{fn(...)}）中提取函数调用
      this.extractTemplateCalls(componentNode.id, scriptBlocks);

      // 从模板中提取组件用法（<ComponentName>）
      this.extractTemplateComponents(componentNode.id);

      // 过滤掉 Svelte rune 调用（$state、$props、$derived 等）
      this.unresolvedReferences = this.unresolvedReferences.filter(
        ref => !SVELTE_RUNES.has(ref.referenceName)
      );
    } catch (error) {
      this.errors.push({
        message: `Svelte extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
   * 为 .svelte 文件创建组件节点
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.svelte$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'svelte',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Svelte 组件总是可导入的
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /**
   * 从 Svelte 源码中提取 <script> 块
   */
  private extractScriptBlocks(): Array<{
    content: string;
    startLine: number;
    isModule: boolean;
    isTypeScript: boolean;
  }> {
    const blocks: Array<{
      content: string;
      startLine: number;
      isModule: boolean;
      isTypeScript: boolean;
    }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || '';
      const content = match.groups?.content || match[2] || '';

      // 从 lang 属性检测 TypeScript
      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);

      // 检测模块 script
      const isModule = /context\s*=\s*["']module["']/.test(attrs);

      // 计算内容开始处的 0 索引行号。内容紧接在开标签 `>` 之后开始——
      // 其前导 `\n` 属于内容的一部分，因此相对行 1 位于标签闭合行上
      // （此处加 1 会重复计算嵌入的换行符，使每个 script 块符号下移一行）。
      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines; // 0 索引行号

      blocks.push({
        content,
        startLine: contentStartLine,
        isModule,
        isTypeScript,
      });
    }

    return blocks;
  }

  /**
   * 将 script 块委托给 TreeSitterExtractor 处理
   */
  private processScriptBlock(
    block: { content: string; startLine: number; isModule: boolean; isTypeScript: boolean },
    componentNodeId: string
  ): void {
    const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

    // 检查 script 语言的 parser 是否可用
    if (!isLanguageSupported(scriptLanguage)) {
      this.errors.push({
        message: `Parser for ${scriptLanguage} not available, cannot parse Svelte script block`,
        severity: 'warning',
      });
      return;
    }

    // 委托给 TreeSitterExtractor
    const extractor = new TreeSitterExtractor(this.filePath, block.content, scriptLanguage);
    const result = extractor.extract();

    // 将 script 块中的行号偏移回 .svelte 文件的位置
    for (const node of result.nodes) {
      node.startLine += block.startLine;
      node.endLine += block.startLine;
      node.language = 'svelte'; // 标记为 svelte，而非 TS/JS

      this.nodes.push(node);

      // 添加从组件到此节点的包含边
      this.edges.push({
        source: componentNodeId,
        target: node.id,
        kind: 'contains',
      });
    }

    // 偏移边（边引用了行号）
    for (const edge of result.edges) {
      if (edge.line) {
        edge.line += block.startLine;
      }
      this.edges.push(edge);
    }

    // 偏移未解析引用
    for (const ref of result.unresolvedReferences) {
      ref.line += block.startLine;
      ref.filePath = this.filePath;
      ref.language = 'svelte';
      this.unresolvedReferences.push(ref);
    }

    // 传递错误
    for (const error of result.errors) {
      if (error.line) {
        error.line += block.startLine;
      }
      this.errors.push(error);
    }
  }

  /**
   * 从 Svelte 模板表达式中提取函数调用。
   *
   * 在 Svelte 中，许多函数调用发生在标记中（例如 `class={cn(...)}`），
   * 而不在 `<script>` 块内。我们扫描模板中的 `{expression}` 块并从中
   * 提取调用模式。
   */
  private extractTemplateCalls(
    componentNodeId: string,
    _scriptBlocks: Array<{ content: string; startLine: number }>
  ): void {
    // 构建 <script> 和 <style> 块覆盖的行范围集合，以便跳过这些范围
    const coveredRanges: Array<[number, number]> = [];

    // 查找所有 <script>...</script> 和 <style>...</style> 范围
    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    // 查找模板表达式：script/style 块之外的 {...}
    // 匹配花括号表达式，排除 Svelte 块语法（{#if}、{:else}、{/if}、{@html}、{@render}）
    const lines = this.source.split('\n');
    const exprRegex = /\{([^}#/:@][^}]*)\}/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      // 跳过 script/style 块内的行
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let exprMatch;
      while ((exprMatch = exprRegex.exec(line)) !== null) {
        const expr = exprMatch[1]!;
        // 提取函数调用：标识符后跟 (
        // 匹配：cn(...)、buttonVariants(...)、obj.method(...)
        const callRegex = /\b([a-zA-Z_$][\w$.]*)\s*\(/g;
        let callMatch;
        while ((callMatch = callRegex.exec(expr)) !== null) {
          const calleeName = callMatch[1]!;
          // 跳过 Svelte rune、控制流关键字和常见非函数模式
          if (SVELTE_RUNES.has(calleeName)) continue;
          if (calleeName === 'if' || calleeName === 'else' || calleeName === 'each' || calleeName === 'await') continue;

          this.unresolvedReferences.push({
            fromNodeId: componentNodeId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: lineIdx + 1, // 1 索引
            column: exprMatch.index + callMatch.index,
            filePath: this.filePath,
            language: 'svelte',
          });
        }
      }
    }
  }

  /**
   * 从 Svelte 模板中提取组件用法。
   *
   * <Modal>、<Button />、<DevServerPreview> 这样的 PascalCase 标签表示
   * 组件实例化——类似于命令式代码中的函数调用。捕获这些用法可创建从父
   * 组件到子组件的图边，并为 synapse_explore 在模板标记中提供锚点。
   */
  private extractTemplateComponents(componentNodeId: string): void {
    // 构建 <script> 和 <style> 块覆盖的范围，以便跳过这些范围
    const coveredRanges: Array<[number, number]> = [];
    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    const lines = this.source.split('\n');
    // 匹配 PascalCase 开标签/自闭合标签（闭合标签 </Foo> 以 </ 开头，不会匹配）
    const componentTagRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let match;
      while ((match = componentTagRegex.exec(line)) !== null) {
        const componentName = match[1]!;

        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: lineIdx + 1, // 1 索引
          column: match.index + 1,
          filePath: this.filePath,
          language: 'svelte',
        });
      }
    }
  }
}
