import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * MyBatisExtractor——解析 MyBatis mapper XML 文件。
 *
 * MyBatis 将 DAO 接口拆分到两个文件：Java 接口（由 tree-sitter 解析）声明方法，
 * XML mapper 文件以 `<namespace>`（完全限定 Java 类型名）和 `id`（方法名）为键
 * 存储 SQL。若图中缺少 XML 侧，`trace(Controller, ...DAO.method)` 会在接口方法处
 * 断开——实际执行的 SQL 不可见，"此查询涉及哪些内容"/"此列在哪里被写入"等问题
 * 无法回答。
 *
 * 本提取器为每个 `<select|insert|update|delete>` 和每个 `<sql>` 片段生成一个
 * 方法形节点，限定名为 `<namespace>::<id>`，供 MyBatis 框架合成器
 * （`src/resolution/frameworks/mybatis.ts`）通过后缀匹配限定名，将对应的
 * Java 方法链接到 XML 语句。语句内的 `<include refid="...">` 会生成对 SQL 片段
 * 的未解析引用，同样以 `<namespace>::<refid>` 为键。
 *
 * 非 mapper XML（Maven `pom.xml`、Spring beans XML、`web.xml`、log4j 配置等）
 * 通过缺少 `<mapper namespace="...">` 根标签来识别，仅返回文件节点——
 * 我们仍需要文件行以便 watcher 跟踪，但不生成符号。
 */
export class MyBatisExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lineStarts: number[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.computeLineStarts();
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    const fileNode = this.createFileNode();

    try {
      const mapperMatch = this.findMapperRoot();
      if (mapperMatch) {
        this.extractMapper(fileNode.id, mapperMatch.namespace, mapperMatch.bodyStart, mapperMatch.bodyEnd);
      }
    } catch (error) {
      this.errors.push({
        message: `MyBatis extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const node: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'xml',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /**
   * 查找 `<mapper namespace="X">` 开标签。返回命名空间和 body 的字节偏移
   * （开标签与闭标签之间），以便将语句提取限定在 mapper 内容范围内。
   */
  private findMapperRoot(): { namespace: string; bodyStart: number; bodyEnd: number } | null {
    const open = /<mapper\b([^>]*)>/.exec(this.source);
    if (!open) return null;
    const attrs = open[1] ?? '';
    const nsMatch = /\bnamespace\s*=\s*"([^"]+)"/.exec(attrs);
    if (!nsMatch) return null;
    const bodyStart = open.index + open[0].length;
    const closeIdx = this.source.indexOf('</mapper>', bodyStart);
    const bodyEnd = closeIdx >= 0 ? closeIdx : this.source.length;
    return { namespace: nsMatch[1]!, bodyStart, bodyEnd };
  }

  private extractMapper(fileNodeId: string, namespace: string, bodyStart: number, bodyEnd: number): void {
    const body = this.source.slice(bodyStart, bodyEnd);
    // 匹配每个顶层语句形元素。body 中可能包含嵌套标签（`<if>`、`<foreach>`、
    // `<include>`），因此使用正则将开标签与其匹配的闭标签配对扫描——
    // 下面的简单形式有效，因为 MyBatis 语句元素本身不嵌套。
    const stmtRegex = /<(select|insert|update|delete|sql)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let m: RegExpExecArray | null;
    while ((m = stmtRegex.exec(body)) !== null) {
      const elemType = m[1]!;
      const attrs = m[2] ?? '';
      const elemBody = m[3] ?? '';
      const idMatch = /\bid\s*=\s*"([^"]+)"/.exec(attrs);
      if (!idMatch) continue;
      const id = idMatch[1]!;
      const absoluteIndex = bodyStart + m.index;
      const startLine = this.getLineNumber(absoluteIndex);
      const endLine = this.getLineNumber(absoluteIndex + m[0].length);
      const qualified = `${namespace}::${id}`;
      const isSqlFragment = elemType === 'sql';
      const nodeId = generateNodeId(this.filePath, 'method', qualified, startLine);
      const node: Node = {
        id: nodeId,
        kind: 'method',
        name: id,
        qualifiedName: qualified,
        filePath: this.filePath,
        language: 'xml',
        signature: this.buildSignature(elemType, attrs, isSqlFragment),
        startLine,
        endLine,
        startColumn: 0,
        endColumn: 0,
        docstring: this.previewSql(elemBody),
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      // <include refid="X"/> → 对此 mapper 中 SQL 片段的引用
      // （当 refid 带限定符时可能引用另一个 mapper，例如 `ns.X`）。
      const includeRegex = /<include\b[^>]*\brefid\s*=\s*"([^"]+)"/g;
      let inc: RegExpExecArray | null;
      while ((inc = includeRegex.exec(elemBody)) !== null) {
        const refid = inc[1]!;
        const refQualified = refid.includes('.') ? refid.replace(/\./g, '::') : `${namespace}::${refid}`;
        const includeOffset = absoluteIndex + (m[0].length - m[3]!.length - `</${elemType}>`.length) + inc.index;
        const line = this.getLineNumber(includeOffset);
        this.unresolvedReferences.push({
          fromNodeId: nodeId,
          referenceName: refQualified,
          referenceKind: 'references',
          line,
          column: 0,
        });
      }
    }
  }

  private buildSignature(elemType: string, attrs: string, isSqlFragment: boolean): string {
    if (isSqlFragment) return '<sql>';
    const verb = elemType.toUpperCase();
    const result = /\bresultType\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    const param = /\bparameterType\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    const parts = [verb];
    if (param) parts.push(`param=${param}`);
    if (result) parts.push(`result=${result}`);
    return parts.join(' ');
  }

  private previewSql(body: string): string {
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  private computeLineStarts(): void {
    this.lineStarts = [0];
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  private getLineNumber(offset: number): number {
    // 二分查找
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}
