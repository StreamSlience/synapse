import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

/**
 * Astro 内置组件——由编译器提供（`<Fragment>`）或由
 * `astro:components` 附带（`<Code>`、`<Debug>`），不属于用户代码。
 */
const ASTRO_BUILTIN_COMPONENTS = new Set(['Fragment', 'Code', 'Debug']);

/**
 * AstroExtractor - 从 Astro 组件文件中提取代码关系
 *
 * Astro 文件是多语言混合的：一个由 `---` 行围起的 TypeScript frontmatter 块、
 * 一个类 JSX 的 HTML 模板，以及可选的 <script>/<style> 块。
 * 我们不解析完整的 Astro 语法，而是提取 frontmatter 和 <script> 内容，
 * 并将其委托给 TypeScript TreeSitterExtractor
 * （Astro 默认将两者都作为 TypeScript 处理——无需 `lang` 属性）。
 *
 * 同时从模板表达式（`{fn(...)}`）中提取函数调用，
 * 并从组件用法（`<PascalCase>`）中提取引用，
 * 以确保即使唯一的引用存在于标记中，跨文件边也能被捕获。
 *
 * 每个 .astro 文件都会生成一个组件节点（Astro 组件始终可导入）。
 */
export class AstroExtractor {
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
   * 从 Astro 源码中提取内容
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // 为 .astro 文件本身创建组件节点
      const componentNode = this.createComponentNode();

      // 提取并处理 frontmatter 块（--- 围起，TypeScript）
      const frontmatter = this.extractFrontmatter();
      if (frontmatter) {
        this.processScriptContent(frontmatter, componentNode.id, 'frontmatter');
      }

      // 提取并处理 <script> 块（客户端，支持 TypeScript）
      for (const block of this.extractScriptBlocks()) {
        this.processScriptContent(block, componentNode.id, 'script');
      }

      // 模板扫描必须跳过的范围：frontmatter + <script>/<style>
      const coveredRanges = this.getCoveredRanges(frontmatter);

      // 从模板表达式（{fn(...)}）中提取函数调用
      this.extractTemplateCalls(componentNode.id, coveredRanges);

      // 从模板中提取组件用法（<ComponentName>）
      this.extractTemplateComponents(componentNode.id, coveredRanges);
    } catch (error) {
      this.errors.push({
        message: `Astro extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
   * 为 .astro 文件创建组件节点
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.astro$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'astro',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Astro 组件始终可导入
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /**
   * 提取 frontmatter 块：位于开头 `---` 围栏（文件第一个非空行）
   * 与结尾 `---` 围栏之间的内容。
   * 未闭合的围栏视为"无 frontmatter"，而非将整个模板当作 TypeScript 吞掉。
   *
   * 返回内容及其 0-indexed 起始行，若不存在则返回 null。
   */
  private extractFrontmatter(): { content: string; startLine: number; endLine: number } | null {
    const lines = this.source.split('\n');

    // 开头围栏必须是第一个非空行
    let openIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed === '') continue;
      if (trimmed === '---') openIdx = i;
      break;
    }
    if (openIdx === -1) return null;

    // 结尾围栏
    let closeIdx = -1;
    for (let i = openIdx + 1; i < lines.length; i++) {
      if (lines[i]!.trim() === '---') {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx === -1) return null;

    return {
      content: lines.slice(openIdx + 1, closeIdx).join('\n'),
      startLine: openIdx + 1, // 内容起始处的 0-indexed 行号
      endLine: closeIdx, // 结尾围栏的 0-indexed 行号
    };
  }

  /**
   * 从模板部分提取 <script> 块
   */
  private extractScriptBlocks(): Array<{ content: string; startLine: number }> {
    const blocks: Array<{ content: string; startLine: number }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const content = match.groups?.content || match[2] || '';

      // 计算内容起始处的 0-indexed 行号。内容紧接在开始标签的 `>` 之后——
      // 其开头的 `\n` 属于内容的一部分，因此相对第 1 行位于标签闭合行上
      // （此处不加 1；否则会对内嵌换行符重复计数）。
      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines; // 0-indexed

      blocks.push({ content, startLine: contentStartLine });
    }

    return blocks;
  }

  /**
   * 通过委托给 TreeSitterExtractor 来处理 frontmatter / script 内容。
   * Astro 默认将两者均视为 TypeScript。
   */
  private processScriptContent(
    block: { content: string; startLine: number },
    componentNodeId: string,
    label: 'frontmatter' | 'script'
  ): void {
    if (!isLanguageSupported('typescript')) {
      this.errors.push({
        message: `Parser for typescript not available, cannot parse Astro ${label} block`,
        severity: 'warning',
      });
      return;
    }

    // 委托给 TreeSitterExtractor
    const extractor = new TreeSitterExtractor(this.filePath, block.content, 'typescript');
    const result = extractor.extract();

    // 将块内的行号偏移量还原到 .astro 文件的绝对位置
    for (const node of result.nodes) {
      node.startLine += block.startLine;
      node.endLine += block.startLine;
      node.language = 'astro'; // 标记为 astro，而非 TypeScript

      this.nodes.push(node);

      // 添加从组件到此节点的包含边
      this.edges.push({
        source: componentNodeId,
        target: node.id,
        kind: 'contains',
      });
    }

    // 偏移边的行号（边引用行号）
    for (const edge of result.edges) {
      if (edge.line) {
        edge.line += block.startLine;
      }
      this.edges.push(edge);
    }

    // 偏移未解析引用的行号
    for (const ref of result.unresolvedReferences) {
      ref.line += block.startLine;
      ref.filePath = this.filePath;
      ref.language = 'astro';
      this.unresolvedReferences.push(ref);
    }

    // 传递错误信息
    for (const error of result.errors) {
      if (error.line) {
        error.line += block.startLine;
      }
      this.errors.push(error);
    }
  }

  /**
   * 模板扫描必须跳过的行范围（0-indexed，含两端）：
   * frontmatter 块和 <script>/<style> 块。
   */
  private getCoveredRanges(
    frontmatter: { startLine: number; endLine: number } | null
  ): Array<[number, number]> {
    const coveredRanges: Array<[number, number]> = [];

    if (frontmatter) {
      // 从开头围栏行覆盖到结尾围栏行
      coveredRanges.push([frontmatter.startLine - 1, frontmatter.endLine]);
    }

    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    return coveredRanges;
  }

  /**
   * 从 Astro 模板表达式中提取函数调用。
   *
   * Astro 模板嵌入了类 JSX 的表达式（`{formatDate(post.date)}`、
   * `class:list={cn(...)}`），因此调用频繁出现在标记中而非 frontmatter。
   * 我们扫描模板行中的 `{expression}` 组，并从中提取调用模式。
   * 行末未闭合的 `{` 组（普遍存在的 `{posts.map((post) => (` 模式）
   * 贡献其开头行上的调用。
   */
  private extractTemplateCalls(
    componentNodeId: string,
    coveredRanges: Array<[number, number]>
  ): void {
    const lines = this.source.split('\n');
    // 完整组：{...}——排除 JSX 注释（{/* ... */}）
    const exprRegex = /\{([^}/][^}]*)\}/g;
    // 本行上未闭合的组
    const openExprRegex = /\{([^}/][^}]*)$/;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      const exprs: Array<{ text: string; offset: number }> = [];

      let exprMatch;
      while ((exprMatch = exprRegex.exec(line)) !== null) {
        exprs.push({ text: exprMatch[1]!, offset: exprMatch.index });
      }
      const openMatch = openExprRegex.exec(line.replace(exprRegex, ''));
      if (openMatch) {
        exprs.push({ text: openMatch[1]!, offset: line.lastIndexOf('{') });
      }

      for (const expr of exprs) {
        // 提取函数调用：标识符后跟 (
        // 匹配：cn(...)、formatDate(...)、obj.method(...)
        const callRegex = /\b([a-zA-Z_$][\w$.]*)\s*\(/g;
        let callMatch;
        while ((callMatch = callRegex.exec(expr.text)) !== null) {
          const calleeName = callMatch[1]!;
          // 跳过表达式内合法的控制流关键字
          if (calleeName === 'if' || calleeName === 'await' || calleeName === 'function') continue;

          this.unresolvedReferences.push({
            fromNodeId: componentNodeId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: lineIdx + 1, // 1-indexed（1 起始行号）
            column: expr.offset + callMatch.index,
            filePath: this.filePath,
            language: 'astro',
          });
        }
      }
    }
  }

  /**
   * 从 Astro 模板中提取组件用法。
   *
   * `<Layout>`、`<PostCard />` 这样的 PascalCase 标签代表组件实例化——
   * 类似于命令式代码中的函数调用。
   * 小写标签是原生 HTML（Astro 不像 Vue 那样注册 kebab-case 组件，
   * 因此它们是真正的自定义元素，会被跳过）。
   */
  private extractTemplateComponents(
    componentNodeId: string,
    coveredRanges: Array<[number, number]>
  ): void {
    const lines = this.source.split('\n');
    // 开/自闭合标签（闭合标签 </Foo> 以 </ 开头，不会匹配）
    const componentTagRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let match;
      while ((match = componentTagRegex.exec(line)) !== null) {
        const componentName = match[1]!;
        if (ASTRO_BUILTIN_COMPONENTS.has(componentName)) continue;

        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: lineIdx + 1, // 1-indexed（1 起始行号）
          column: match.index + 1,
          filePath: this.filePath,
          language: 'astro',
        });
      }
    }
  }
}
