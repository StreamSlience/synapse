import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

/**
 * RazorExtractor——从 ASP.NET Razor（`.cshtml`）和 Blazor（`.razor`）标记中
 * 提取代码关系。
 *
 * 标记驱动的 code-behind、视图模型、组件和 DTO 仅从标记中被引用，而引擎
 * 本身并不解析这些标记，因此它们看起来没有任何依赖。本提取器将标记链接到
 * 其所命名的 C# 类型：
 *
 *  - `@model Foo` / `@inherits Bar<Foo>`  → 视图模型 / 基类型（.cshtml + .razor）
 *  - `@inject IService svc`               → 注入的服务类型
 *  - `@typeof(MainLayout)`                → 引用的类型
 *  - `<MyComponent .../>` （仅 Blazor）  → 组件类（.razor 或 `.cs : ComponentBase`）
 *  - `<Grid TItem="CatalogItem">`         → 泛型类型参数
 *
 * 风险缓解措施（见 docs/design/template-markup-parser.md）：
 *  - 只有 PascalCase（大写字母开头）标签才被视为组件——HTML 元素为小写，
 *    因此永远不会匹配。已知的 Blazor 框架组件会被跳过（它们不在代码库中，
 *    因此引用只会悬空）。
 *  - 每个文件恰好生成一个 `component` 节点；组件标签成为 `references` 边，
 *    而非节点——不会因标签而节点爆炸。
 *  - 生成的引用是普通的按名 `references`，由名称匹配器解析；
 *    `razor` 与 `csharp` 共享 `dotnet` 语言族（name-matcher.ts），
 *    因此跨族门控不会丢弃它们。
 *  - `.cshtml`/`.razor` 已在 grammars.ts 中注册，因此会被索引。
 *
 * 超出范围（数据流 / 低价值）：`asp-for`/`th:field` 属性字符串绑定；
 * `@code { }` / `@{ }` 块中的 C#（嵌入式 C# 的噪声正则）。
 */

/**
 * Blazor 框架提供的组件——由运行时调用，不在代码库中定义，
 * 因此对它们的引用永远无法解析。跳过以避免悬空引用。
 */
const BLAZOR_BUILTIN_COMPONENTS = new Set([
  'Router', 'Found', 'NotFound', 'RouteView', 'AuthorizeRouteView', 'LayoutView',
  'CascadingValue', 'CascadingAuthenticationState', 'AuthorizeView', 'Authorized',
  'NotAuthorized', 'Authorizing', 'EditForm', 'DataAnnotationsValidator',
  'ValidationSummary', 'ValidationMessage', 'InputText', 'InputNumber',
  'InputCheckbox', 'InputSelect', 'InputDate', 'InputTextArea', 'InputRadio',
  'InputRadioGroup', 'InputFile', 'PageTitle', 'HeadContent', 'HeadOutlet',
  'Virtualize', 'DynamicComponent', 'ErrorBoundary', 'SectionContent',
  'SectionOutlet', 'FocusOnNavigate', 'NavLink', 'Microsoft',
]);

export class RazorExtractor {
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

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const componentId = this.createComponentNode().id;
      this.extractDirectives(componentId);
      // 仅限 Blazor 组件标签——`.cshtml` 使用 HTML + 标签助手，
      // 而非 PascalCase 组件元素。
      if (this.filePath.toLowerCase().endsWith('.razor')) {
        this.extractComponentTags(componentId);
      }
      // 将 `@code { }` / `@functions { }` / `@{ }` 块中的 C# 委托给
      // C# tree-sitter 提取器（相当于 Blazor 版的 Svelte <script> 块）——
      // 这里是组件逻辑使用服务/DTO 的地方，因此涵盖了仅从组件代码中引用的类型。
      this.processCodeBlocks(componentId);
    } catch (error) {
      this.errors.push({
        message: `Razor extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.(razor|cshtml)$/i, '');
    const node: Node = {
      id: generateNodeId(this.filePath, 'component', componentName, 1),
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'razor',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /** 最后一个 `.` 分段（`App.ViewModels.RegisterModel` → `RegisterModel`）。 */
  private lastSegment(s: string): string {
    const i = s.lastIndexOf('.');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /**
   * 将类型表达式拆分为其包含的大写类型名——基类型加上所有泛型参数
   * （`Bar<Foo, Baz>` → `Bar`、`Foo`、`Baz`），每个名称均缩减为最后一个
   * 命名空间分段。小写/关键字词元会被丢弃。
   */
  private typeNames(expr: string): string[] {
    const out: string[] = [];
    for (const raw of expr.split(/[<>,\s]+/)) {
      const seg = this.lastSegment(raw.trim());
      if (/^[A-Z][A-Za-z0-9_]*$/.test(seg)) out.push(seg);
    }
    return out;
  }

  private pushRef(componentId: string, name: string, line: number, column: number): void {
    this.unresolvedReferences.push({
      fromNodeId: componentId,
      referenceName: name,
      referenceKind: 'references',
      line,
      column,
      filePath: this.filePath,
      language: 'razor',
    });
  }

  private extractDirectives(componentId: string): void {
    const lines = this.source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // `@model Foo` / `@inherits Bar<Foo>` — 指令后跟类型。
      const dir = line.match(/^\s*@(?:model|inherits)\s+([A-Za-z_][\w.]*(?:\s*<[^>]+>)?)/);
      if (dir) for (const t of this.typeNames(dir[1]!)) this.pushRef(componentId, t, i + 1, 0);
      // `@inject IService name` — 类型是第一个词元，名称跟在后面。
      const inj = line.match(/^\s*@inject\s+([A-Za-z_][\w.]*(?:\s*<[^>]+>)?)\s+[A-Za-z_]/);
      if (inj) for (const t of this.typeNames(inj[1]!)) this.pushRef(componentId, t, i + 1, 0);
      // `@typeof(X)` 出现在行中的任何位置。
      for (const m of line.matchAll(/@typeof\(\s*([A-Za-z_][\w.]*)\s*\)/g)) {
        const seg = this.lastSegment(m[1]!);
        if (/^[A-Z]/.test(seg)) this.pushRef(componentId, seg, i + 1, m.index ?? 0);
      }
    }
  }

  private extractComponentTags(componentId: string): void {
    const lines = this.source.split('\n');
    // PascalCase 开标签 / 自闭合标签。闭合标签（`</Foo>`）以 `</` 开头，
    // 会被跳过。HTML 元素为小写，永远不会匹配。
    const tagRe = /<([A-Z][A-Za-z0-9_]*)\b([^>]*)>/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(line)) !== null) {
        const name = m[1]!;
        if (BLAZOR_BUILTIN_COMPONENTS.has(name)) continue;
        this.pushRef(componentId, name, i + 1, m.index + 1);
        // 泛型组件类型参数：`<Grid TItem="CatalogItem">`。
        for (const t of (m[2] || '').matchAll(/\bT[A-Za-z]*\s*=\s*"([A-Za-z_][\w.]*)"/g)) {
          const seg = this.lastSegment(t[1]!);
          if (/^[A-Z]/.test(seg)) this.pushRef(componentId, seg, i + 1, 0);
        }
      }
    }
  }

  /**
   * 查找 `openIdx` 处 `{` 对应的 `}`，跳过字符串字面量和注释，
   * 避免 `"{"` / `// }` 中的花括号干扰计数。
   * 返回闭合花括号的索引，若不平衡则返回 -1。
   */
  private matchBrace(src: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** `@code { … }` / `@functions { … }`（Blazor）和 `@{ … }`（Razor）C# 块。 */
  private extractCodeBlocks(): Array<{ content: string; lineOffset: number }> {
    const blocks: Array<{ content: string; lineOffset: number }> = [];
    const re = /@(?:code|functions)\b\s*\{|@\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.source)) !== null) {
      const openIdx = this.source.indexOf('{', m.index);
      if (openIdx < 0) continue;
      const close = this.matchBrace(this.source, openIdx);
      if (close < 0) continue;
      const content = this.source.slice(openIdx + 1, close);
      // 内容第一个字符前的换行数 → 内容开始处的 0 索引行号
      const lineOffset = (this.source.slice(0, openIdx + 1).match(/\n/g) || []).length;
      blocks.push({ content, lineOffset });
      re.lastIndex = close;
    }
    return blocks;
  }

  /**
   * 将每个 `@code`/`@functions`/`@{` 块的 C# 委托给 tree-sitter C# 提取器，
   * 并将块的外部引用（服务/DTO 调用、`new X()`、类型使用）归属到组件。
   * 块被包裹在合成类中，使 tree-sitter 在类上下文中解析组件的字段/方法
   * （Blazor `@code` 体会编译进组件的 partial 类）。我们只保留依赖引用——
   * 覆盖只需要到外部类型的边，不需要每个成员节点。若 C# grammar 未加载
   * 则优雅降级。
   */
  private processCodeBlocks(componentId: string): void {
    if (!isLanguageSupported('csharp')) return;
    for (const block of this.extractCodeBlocks()) {
      if (!block.content.trim()) continue;
      let result: ExtractionResult;
      try {
        result = new TreeSitterExtractor(
          this.filePath,
          `class __RazorCode__ {\n${block.content}\n}`,
          'csharp'
        ).extract();
      } catch {
        continue; // grammar 未加载 / 解析失败——跳过此块
      }
      // 合成包裹在块内容前添加了一行；将引用行号映射回 .razor 文件
      // （仅用于显示——覆盖与行号无关）。
      for (const ref of result.unresolvedReferences) {
        this.unresolvedReferences.push({
          ...ref,
          fromNodeId: componentId,
          line: ref.line + block.lineOffset - 1,
          column: ref.column,
          filePath: this.filePath,
          language: 'razor',
        });
      }
    }
  }
}
