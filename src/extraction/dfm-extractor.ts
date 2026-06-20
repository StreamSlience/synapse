import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * Delphi DFM/FMX 表单文件的自定义提取器。
 *
 * DFM/FMX 文件描述可视化组件层级与事件处理器绑定，
 * 使用简单的文本格式（object/end 块），通过正则解析——
 * 该格式目前没有对应的 tree-sitter 语法。
 *
 * 提取的信息：
 * - 组件，NodeKind 为 `component`
 * - 嵌套关系，EdgeKind 为 `contains`
 * - 事件处理器（OnClick = MethodName），UnresolvedReference → EdgeKind `references`
 */
export class DfmExtractor {
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
   * 从 DFM/FMX 源码中提取组件和事件处理器引用
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      this.parseComponents(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `DFM extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /** 为 DFM 表单文件创建文件节点 */
  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);

    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'pascal',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };

    this.nodes.push(fileNode);
    return fileNode;
  }

  /** 解析 object/end 块，提取组件及事件处理器 */
  private parseComponents(fileNodeId: string): void {
    const lines = this.source.split('\n');
    const stack: string[] = [fileNodeId];

    const objectPattern = /^\s*(object|inherited|inline)\s+(\w+)\s*:\s*(\w+)/;
    const eventPattern = /^\s*(On\w+)\s*=\s*(\w+)\s*$/;
    const endPattern = /^\s*end\s*$/;
    const multiLineStart = /=\s*\(\s*$/;
    const multiLineItemStart = /=\s*<\s*$/;
    let inMultiLine = false;
    let multiLineEndChar = ')';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // 跳过多行属性
      if (inMultiLine) {
        if (line.trimEnd().endsWith(multiLineEndChar)) inMultiLine = false;
        continue;
      }
      if (multiLineStart.test(line)) {
        inMultiLine = true;
        multiLineEndChar = ')';
        continue;
      }
      if (multiLineItemStart.test(line)) {
        inMultiLine = true;
        multiLineEndChar = '>';
        continue;
      }

      // 组件声明
      const objMatch = line.match(objectPattern);
      if (objMatch) {
        const [, , name, typeName] = objMatch;
        const nodeId = generateNodeId(this.filePath, 'component', name!, lineNum);
        this.nodes.push({
          id: nodeId,
          kind: 'component',
          name: name!,
          qualifiedName: `${this.filePath}#${name}`,
          filePath: this.filePath,
          language: 'pascal',
          startLine: lineNum,
          endLine: lineNum,
          startColumn: 0,
          endColumn: line.length,
          signature: typeName,
          updatedAt: Date.now(),
        });
        this.edges.push({
          source: stack[stack.length - 1]!,
          target: nodeId,
          kind: 'contains',
        });
        stack.push(nodeId);
        continue;
      }

      // 事件处理器
      const eventMatch = line.match(eventPattern);
      if (eventMatch) {
        const [, , methodName] = eventMatch;
        this.unresolvedReferences.push({
          fromNodeId: stack[stack.length - 1]!,
          referenceName: methodName!,
          referenceKind: 'references',
          line: lineNum,
          column: 0,
        });
        continue;
      }

      // 块结束
      if (endPattern.test(line)) {
        if (stack.length > 1) stack.pop();
      }
    }
  }
}
