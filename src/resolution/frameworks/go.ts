/**
 * Go 框架解析器
 *
 * 处理 Gin、Echo、Fiber、Chi 及标准库模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const goResolver: FrameworkResolver = {
  name: 'go',
  languages: ['go'],

  detect(context: ResolutionContext): boolean {
    // 检查 go.mod 文件（Go modules）
    const goMod = context.readFile('go.mod');
    if (goMod) {
      return true;
    }

    // 检查 .go 文件
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.go'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：Handler 引用
    if (ref.referenceName.endsWith('Handler') || ref.referenceName.startsWith('Handle')) {
      const result = resolveByNameAndKind(ref.referenceName, 'function', HANDLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 2：Service/Repository 引用
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Repository') || ref.referenceName.endsWith('Store')) {
      const result = resolveByNameAndKind(ref.referenceName, null, SERVICE_DIRS, context, SERVICE_KINDS);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：Middleware 引用
    if (ref.referenceName.endsWith('Middleware') || ref.referenceName.startsWith('Auth') || ref.referenceName.startsWith('Log')) {
      const result = resolveByNameAndKind(ref.referenceName, 'function', MIDDLEWARE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 4：Model/Entity 引用（通常为 PascalCase 结构体）
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, 'struct', MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.go')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'go');

    // <anyVar>.METHOD("/path", handler) — Gin（GET/POST/...）、Chi（Get/Post/...）、
    // net/http（HandleFunc/Handle）。接收者为任意标识符，不仅限于
    // router|r|mux|app|e：真实项目中路由定义在分组变量上（`v1.GET`、`PublicGroup.GET`、
    // `userRouter.POST`），固定名称列表会遗漏这些（gin-vue-admin：625 个文件中仅匹配 4 条路由）。
    // 动词 + 字符串路径 + handler 参数的组合可将范围限定在路由调用上。
    const routeRegex = /\b\w+\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Handle|HandleFunc)\s*\(\s*"([^"]+)"\s*,\s*([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, rawMethod, routePath, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const method =
        rawMethod === 'Handle' || rawMethod === 'HandleFunc'
          ? 'ANY'
          : rawMethod!.toUpperCase();

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'go',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handlerName = extractGoTailIdent(handlerExpr!);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'go',
        });
      }
    }

    return { nodes, references };
  },
};

/** 从 `pkg.Sub.handler` 或 `handler` 之类的表达式中提取最后一个标识符。 */
function extractGoTailIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\s+/g, '').replace(/\(\)$/, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}

// 框架解析的目录模式
const HANDLER_DIRS = ['handler', 'handlers', 'api', 'routes', 'controller', 'controllers'];
const SERVICE_DIRS = ['service', 'services', 'repository', 'store', 'pkg'];
const MIDDLEWARE_DIRS = ['middleware', 'middlewares'];
const MODEL_DIRS = ['model', 'models', 'entity', 'entities', 'domain', 'pkg'];
const SERVICE_KINDS = new Set(['struct', 'interface']);

/**
 * 通过名称使用索引查询解析符号，而非扫描所有文件。
 * 使用 getNodesByName（O(log n) 索引查找），而非遍历每个文件。
 */
function resolveByNameAndKind(
  name: string,
  kind: string | null,
  preferredDirs: string[],
  context: ResolutionContext,
  kinds?: Set<string>
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  // 按 kind 过滤
  const kindFiltered = candidates.filter((n) => {
    if (kinds) return kinds.has(n.kind);
    if (kind) return n.kind === kind;
    return true;
  });

  if (kindFiltered.length === 0) return null;

  // 优先选择位于框架惯例目录中的候选项
  const preferred = kindFiltered.filter((n) =>
    preferredDirs.some((d) => n.filePath.includes(`/${d}/`))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // 回退到任意匹配项
  return kindFiltered[0]!.id;
}
