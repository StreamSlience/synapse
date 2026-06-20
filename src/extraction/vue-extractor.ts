import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

/**
 * Vue 内置组件——跳过这些组件，避免模板中的 `<Transition>` / `<KeepAlive>`
 * 成为指向用户组件的幽灵引用。在 kebab→Pascal 转换之后检查，
 * 因此 `<keep-alive>` 也会被捕获。
 */
const VUE_BUILTIN_COMPONENTS = new Set([
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Suspense',
  'Teleport',
  'Component',
  'Slot',
]);

/** `my-component` → `MyComponent`（Vue 模板中两种形式均可使用）。 */
function kebabToPascal(name: string): string {
  return name
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ''))
    .join('');
}

/**
 * VueExtractor——从 Vue 单文件组件中提取代码关系
 *
 * Vue SFC 是多语言的（script + template + style）。我们不解析完整的
 * Vue grammar，而是提取 <script> 块内容并委托给 TypeScript/JavaScript
 * TreeSitterExtractor 处理。
 *
 * 每个 .vue 文件都会生成一个组件节点（Vue 组件总是可导入的）。
 */
export class VueExtractor {
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
   * 从 Vue 源码中提取
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // 为 .vue 文件本身创建组件节点
      const componentNode = this.createComponentNode();

      // 提取并处理 script 块
      const scriptBlocks = this.extractScriptBlocks();

      for (const block of scriptBlocks) {
        this.processScriptBlock(block, componentNode.id);
      }

      // 从 <template> 中提取组件用法（<ComponentName>）。
      // 若没有此步骤，仅在另一个组件标记中使用（包括通过桶式导入）的 Vue 组件
      // 对调用者/影响分析不可见（#629 后续）。
      this.extractTemplateComponents(componentNode.id);
    } catch (error) {
      this.errors.push({
        message: `Vue extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
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
   * 为 .vue 文件创建组件节点
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.vue$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'vue',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Vue 组件总是可导入的
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /**
   * 从 Vue 源码中提取 <script> 和 <script setup> 块
   */
  private extractScriptBlocks(): Array<{
    content: string;
    startLine: number;
    isSetup: boolean;
    isTypeScript: boolean;
  }> {
    const blocks: Array<{
      content: string;
      startLine: number;
      isSetup: boolean;
      isTypeScript: boolean;
    }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || '';
      const content = match.groups?.content || match[2] || '';

      // 从 lang 属性检测 TypeScript
      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);

      // 检测 <script setup>
      const isSetup = /\bsetup\b/.test(attrs);

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
        isSetup,
        isTypeScript,
      });
    }

    return blocks;
  }

  /**
   * 将 script 块委托给 TreeSitterExtractor 处理
   */
  private processScriptBlock(
    block: { content: string; startLine: number; isSetup: boolean; isTypeScript: boolean },
    componentNodeId: string
  ): void {
    const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

    // 检查 script 语言的 parser 是否可用
    if (!isLanguageSupported(scriptLanguage)) {
      this.errors.push({
        message: `Parser for ${scriptLanguage} not available, cannot parse Vue script block`,
        severity: 'warning',
      });
      return;
    }

    // 委托给 TreeSitterExtractor
    const extractor = new TreeSitterExtractor(this.filePath, block.content, scriptLanguage);
    const result = extractor.extract();

    // 将 script 块中的行号偏移回 .vue 文件的位置
    for (const node of result.nodes) {
      node.startLine += block.startLine;
      node.endLine += block.startLine;
      node.language = 'vue'; // 标记为 vue，而非 TS/JS

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
      ref.language = 'vue';
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
   * 从 Vue `<template>` 中提取组件用法。
   *
   * PascalCase 标签（`<Modal>`、`<Button />`）和 kebab-case 标签
   * （`<my-button>`）都表示组件实例化——类似于命令式代码中的函数调用。
   * 捕获它们可创建父→子组件边，让 `callers` / `impact` 能够看到仅在
   * 标记中使用的组件。Vue 的提取器此前只解析 `<script>` 块，因此这些
   * 用法完全不产生边（#629）。
   *
   * HTML 元素（小写、无连字符）和 Vue 内置组件会被跳过。
   * 未匹配的名称在解析时不会创建边，因此对原生自定义元素进行
   * kebab-case 转换也是安全的。
   */
  private extractTemplateComponents(componentNodeId: string): void {
    // 被 <script> / <style> 块覆盖的范围——跳过这些范围，避免将 script
    // 标识符和 CSS 选择器误识别为模板标签。这也能正确处理嵌套的 <template>
    // 标签（v-if / slots）——单个非贪婪的 <template>…</template> 匹配
    // 会错误确定其边界。
    const coveredRanges: Array<[number, number]> = [];
    const blockRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, blockMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (blockMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    const lines = this.source.split('\n');
    // 开标签 / 自闭合标签（闭合标签 </Foo> 以 `</` 开头，因此以名称字母
    // 跟随 `<` 的模式不会匹配它）。
    const tagRegex = /<([A-Za-z][A-Za-z0-9_-]*)\b/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let match;
      while ((match = tagRegex.exec(line)) !== null) {
        const raw = match[1]!;
        let componentName: string;
        if (/^[A-Z]/.test(raw)) {
          componentName = raw; // PascalCase 组件
        } else if (raw.includes('-')) {
          componentName = kebabToPascal(raw); // kebab-case 组件
        } else {
          continue; // 小写无连字符 → 原生 HTML 元素
        }
        if (VUE_BUILTIN_COMPONENTS.has(componentName)) continue;

        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: lineIdx + 1, // 1 索引
          column: match.index + 1,
          filePath: this.filePath,
          language: 'vue',
        });
      }
    }
  }
}
