/**
 * Express/Node.js 框架解析器
 *
 * 处理 Express 及通用 Node.js 模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

function extractTailIdent(expr: string): string | null {
  const cleaned = expr.replace(/\s+/g, '').replace(/\(\)$/, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}

/**
 * `open` 处定界符所匹配的另一半定界符的索引，跳过字符串/模板
 * 字面量，避免字符串内的 `)` 或 `}` 打乱括号平衡计数。
 */
function matchDelim(s: string, open: number, oc: string, cc: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === oc) depth++;
    else if (ch === cc) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Express res/req 方法 + 常见 JS 内建函数——handler 函数体内对这些方法的调用
// 属于框架噪声，不是我们希望作为路由边暴露的业务流程。
const RESERVED_CALLS = new Set([
  'json', 'jsonp', 'send', 'sendStatus', 'sendFile', 'status', 'end', 'redirect',
  'render', 'set', 'get', 'header', 'type', 'format', 'attachment', 'download',
  'cookie', 'clearCookie', 'append', 'location', 'vary', 'links', 'accepts', 'is',
  'next', 'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race',
  'map', 'filter', 'forEach', 'reduce', 'find', 'push', 'pop', 'slice', 'splice',
  'includes', 'keys', 'values', 'entries', 'assign', 'parse', 'stringify',
  'log', 'error', 'warn', 'info', 'String', 'Number', 'Boolean', 'Array', 'Object',
  'Date', 'Math', 'JSON', 'Promise', 'require', 'fail', 'redirect',
]);

export const expressResolver: FrameworkResolver = {
  name: 'express',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    // 检查 package.json 中是否包含 Express
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.express || deps.fastify || deps.koa || deps.hapi) {
          return true;
        }
      } catch {
        // JSON 格式错误
      }
    }

    // 检查常见的 Express 模式
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (
        file.includes('routes') ||
        file.includes('controllers') ||
        file.includes('middleware')
      ) {
        const content = context.readFile(file);
        if (content && (content.includes('express') || content.includes('app.get') || content.includes('router.get'))) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：Middleware 引用
    if (isMiddlewareName(ref.referenceName)) {
      const result = resolveMiddleware(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 2：Controller 方法引用
    const controllerMatch = ref.referenceName.match(/^(\w+)Controller\.(\w+)$/);
    if (controllerMatch) {
      const [, controller, method] = controllerMatch;
      const result = resolveControllerMethod(controller!, method!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：Service/helper 引用
    const serviceMatch = ref.referenceName.match(/^(\w+)(Service|Helper|Utils?)\.(\w+)$/);
    if (serviceMatch) {
      const [, name, suffix, method] = serviceMatch;
      const result = resolveServiceMethod(name! + suffix!, method!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!/\.(m?js|tsx?|cjs)$/.test(filePath)) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang = detectLanguage(filePath);
    const safe = stripCommentsForRegex(content, lang);
    // 匹配路由头部直到第一个参数：(app|router).METHOD('/path',
    // （不匹配整个调用——handler 通常是内联箭头函数，其 `)`/`{}` 无法用
    // 旧的单正则跨越，导致内联 handler 路由无法连接任何节点。）
    const head = /\b(app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]\s*,/g;
    let match: RegExpExecArray | null;
    while ((match = head.exec(safe)) !== null) {
      const method = match[2]!;
      const routePath = match[3]!;
      if (method === 'use' && !routePath.startsWith('/')) continue;
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method.toUpperCase()}:${routePath}`,
        kind: 'route',
        name: `${method.toUpperCase()} ${routePath}`,
        qualifiedName: `${filePath}::${method.toUpperCase()}:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: lang,
        updatedAt: now,
      };
      nodes.push(routeNode);

      // 完整参数列表 = 从路由调用开括号起的括号平衡匹配结果。
      const openParen = safe.indexOf('(', match.index);
      const closeParen = openParen >= 0 ? matchDelim(safe, openParen, '(', ')') : -1;
      const args = closeParen > openParen ? safe.slice(openParen + 1, closeParen) : '';
      const arrowAt = args.indexOf('=>');

      if (arrowAt >= 0) {
        // 内联箭头 handler（`router.post('/x', async (req,res) => {…})`）。
        // 箭头函数是匿名的，因此其函数体——实际的 request→service 流程——会丢失。
        // 将函数体内的调用归属到路由节点作为 `calls` 边，以便
        // `trace(route, service)` 能够连通。函数体 = `=>` 之后的平衡 `{…}`，
        // 或 `=> expr` 箭头的单表达式尾部。
        const afterArrow = args.slice(arrowAt + 2);
        const braceAt = afterArrow.indexOf('{');
        let body = afterArrow;
        if (braceAt >= 0 && afterArrow.slice(0, braceAt).trim() === '') {
          const end = matchDelim(afterArrow, braceAt, '{', '}');
          if (end > braceAt) body = afterArrow.slice(braceAt + 1, end);
        }
        const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
        const seen = new Set<string>();
        let cm: RegExpExecArray | null;
        while ((cm = callRe.exec(body)) !== null) {
          const name = cm[1]!;
          if (seen.has(name) || RESERVED_CALLS.has(name)) continue;
          seen.add(name);
          references.push({
            fromNodeId: routeNode.id,
            referenceName: name,
            referenceKind: 'calls',
            line,
            column: 0,
            filePath,
            language: lang,
          });
        }
      } else {
        // 具名 handler：最后一个逗号分隔的参数（前面的参数是 middleware）。
        const parts = args.split(',').map((s) => s.trim()).filter(Boolean);
        const last = parts[parts.length - 1];
        const handlerName = last ? extractTailIdent(last) : null;
        if (handlerName) {
          references.push({
            fromNodeId: routeNode.id,
            referenceName: handlerName,
            referenceKind: 'references',
            line,
            column: 0,
            filePath,
            language: lang,
          });
        }
      }
    }
    return { nodes, references };
  },
};

/**
 * 判断名称是否看起来像 middleware
 */
function isMiddlewareName(name: string): boolean {
  const middlewarePatterns = [
    /^auth$/i,
    /^authenticate$/i,
    /^authorization$/i,
    /^validate/i,
    /^sanitize/i,
    /^rateLimit/i,
    /^cors$/i,
    /^helmet$/i,
    /^logger$/i,
    /^errorHandler$/i,
    /^notFound$/i,
    /Middleware$/i,
  ];

  return middlewarePatterns.some((p) => p.test(name));
}

/**
 * 使用基于名称的查询解析 middleware 引用
 */
function resolveMiddleware(
  name: string,
  context: ResolutionContext
): string | null {
  // 先尝试精确名称匹配
  const candidates = context.getNodesByName(name);
  const match = candidates.find((n) =>
    n.name.toLowerCase() === name.toLowerCase() ||
    n.name.toLowerCase() === name.replace(/Middleware$/i, '').toLowerCase()
  );
  if (match) return match.id;

  // 尝试去掉 Middleware 后缀
  const baseName = name.replace(/Middleware$/i, '');
  if (baseName !== name) {
    const baseCandidates = context.getNodesByName(baseName);
    const MIDDLEWARE_DIRS = ['/middleware/', '/middlewares/'];
    const preferred = baseCandidates.filter((n) =>
      MIDDLEWARE_DIRS.some((d) => n.filePath.includes(d))
    );
    if (preferred.length > 0) return preferred[0]!.id;
    if (baseCandidates.length > 0) return baseCandidates[0]!.id;
  }

  return null;
}

/**
 * 使用基于名称的查询解析 controller 方法引用
 */
function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  // 直接查找方法名
  const methodCandidates = context.getNodesByName(method);
  const methodNodes = methodCandidates.filter(
    (n) => (n.kind === 'method' || n.kind === 'function') &&
      n.filePath.toLowerCase().includes(controller.toLowerCase())
  );

  if (methodNodes.length > 0) return methodNodes[0]!.id;

  // 回退：查找 controller 类，再在其文件中找到该方法
  const controllerName = controller + 'Controller';
  const controllerCandidates = context.getNodesByName(controllerName);
  for (const ctrl of controllerCandidates) {
    const nodesInFile = context.getNodesInFile(ctrl.filePath);
    const methodNode = nodesInFile.find(
      (n) => (n.kind === 'method' || n.kind === 'function') && n.name === method
    );
    if (methodNode) return methodNode.id;
  }

  return null;
}

/**
 * 使用基于名称的查询解析 service/helper 方法引用
 */
function resolveServiceMethod(
  serviceName: string,
  method: string,
  context: ResolutionContext
): string | null {
  // 在文件名匹配 service 名称的文件中查找该方法
  const methodCandidates = context.getNodesByName(method);
  const stripped = serviceName.replace(/(Service|Helper|Utils?)$/i, '').toLowerCase();
  const methodNodes = methodCandidates.filter(
    (n) => (n.kind === 'method' || n.kind === 'function') &&
      n.filePath.toLowerCase().includes(stripped)
  );

  if (methodNodes.length > 0) return methodNodes[0]!.id;

  return null;
}

/**
 * 从文件扩展名检测语言
 */
function detectLanguage(filePath: string): 'typescript' | 'javascript' {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    return 'typescript';
  }
  return 'javascript';
}
