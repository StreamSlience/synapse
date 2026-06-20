/**
 * Play Framework（Scala/Java）解析器。
 *
 * Play 在专用的 `conf/routes` 文件（以及包含的 `conf/*.routes`）中以 Rails 风格声明 HTTP 路由：
 *
 *   GET   /computers        controllers.Application.list(p: Int ?= 0)
 *   POST  /computers        controllers.Application.save
 *   GET   /assets/*file     controllers.Assets.versioned(path = "/public", file: Asset)
 *
 * 该文件无扩展名，因此文件遍历仅在 `isPlayRoutesFile`（grammars.ts）选择加入时才对其建立索引；
 * 它通过无语法路径处理，由本解析器提取路由。每条路由将其处理器引用为
 * `Controller.method`（包前缀被丢弃），并解析为控制器类中的 action 方法。
 */

import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { isPlayRoutesFile } from '../../extraction/grammars';

const ROUTE_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(.+)$/;
const METHOD_KINDS = new Set(['method', 'function']);
const CLASS_KINDS = new Set(['class']);

export const playResolver: FrameworkResolver = {
  name: 'play',
  // `yaml` 使本解析器运行于 conf/routes（detectLanguage 将其映射为 yaml）；
  // `scala`/`java` 使其在两种语言的 Play 项目中均处于激活状态。
  languages: ['scala', 'java', 'yaml'],

  detect(context: ResolutionContext): boolean {
    const buildSbt = context.readFile('build.sbt');
    if (buildSbt && /playframework|"play"|sbt-plugin|PlayScala|PlayJava/i.test(buildSbt)) return true;
    if (context.fileExists('conf/routes')) return true;
    if (context.fileExists('conf/application.conf')) return true;
    return false;
  },

  // 处理器为 `Controller.method`（类限定的 action），不对应任何裸声明符号，
  // 因此 resolveOne 的预过滤器可能会丢弃它——在此声明认领。
  claimsReference(name: string): boolean {
    return /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const m = ref.referenceName.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
    if (!m) return null;
    const [, className, methodName] = m;
    const classNodes = context.getNodesByName(className!).filter((n) => CLASS_KINDS.has(n.kind));
    for (const cls of classNodes) {
      const method = context
        .getNodesInFile(cls.filePath)
        .find((n) => METHOD_KINDS.has(n.kind) && n.name === methodName);
      if (method) {
        return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' };
      }
    }
    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (!isPlayRoutesFile(filePath)) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      // 跳过注释和 `->` 路由包含（子路由挂载，而非 action）。
      if (!line || line.startsWith('#') || line.startsWith('->')) continue;
      const m = line.match(ROUTE_LINE);
      if (!m) continue;
      const [, method, routePath, action] = m;

      // action：`controllers.Application.list(p: Int ?= 0)` → 丢弃参数，保留最后的
      // `Controller.method` 片段（包前缀与查找无关）。
      const fqn = action!.split('(')[0]!.trim();
      const parts = fqn.split('.').filter(Boolean);
      if (parts.length < 2) continue;
      const handlerRef = parts.slice(-2).join('.'); // Application.list

      const lineNum = i + 1;
      const routeNode: Node = {
        id: `route:${filePath}:${lineNum}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::${method}:${routePath}`,
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        startColumn: 0,
        endColumn: 0,
        language: 'scala',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerRef,
        referenceKind: 'references',
        line: lineNum,
        column: 0,
        filePath,
        language: 'scala',
      });
    }

    return { nodes, references };
  },
};
