/**
 * Rust 框架解析器
 *
 * 处理 Actix-web、Rocket、Axum 及常见 Rust 模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { getCargoWorkspaceCrateMap } from './cargo-workspace';

const cargoWorkspaceMapCache = new WeakMap<ResolutionContext, Map<string, string>>();

function getCachedCargoWorkspaceCrateMap(context: ResolutionContext): Map<string, string> {
  const cached = cargoWorkspaceMapCache.get(context);
  if (cached) return cached;
  const map = getCargoWorkspaceCrateMap(context);
  cargoWorkspaceMapCache.set(context, map);
  return map;
}

export const rustResolver: FrameworkResolver = {
  name: 'rust',
  languages: ['rust'],

  detect(context: ResolutionContext): boolean {
    // 检查 Cargo.toml（Rust 项目标志）
    return context.fileExists('Cargo.toml');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：Handler 引用
    if (ref.referenceName.endsWith('_handler') || ref.referenceName.startsWith('handle_')) {
      const result = resolveByNameAndKind(ref.referenceName, FUNCTION_KINDS, HANDLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 2：Service/Repository trait 实现
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, SERVICE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：Struct 引用（PascalCase）
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, STRUCT_KINDS, MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 4：模块引用
    if (/^[a-z_]+$/.test(ref.referenceName)) {
      const result = resolveModule(ref.referenceName, context);
      if (result) {
        // workspace manifest 命中是从 Cargo.toml 直接得到的精确
        // crate 名 -> crate 根映射，因此其可信度高于
        // 名称匹配器的自文件匹配（后者在 0.7 处获胜，因为
        // 每个包含 `use foo::...` 的文件都有自己的名为 `foo` 的 import 节点）。
        return {
          original: ref,
          targetNodeId: result.targetId,
          confidence: result.fromWorkspace ? 0.95 : 0.6,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.rs')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'rust');

    // Actix-web / Rocket 属性：#[get("/path")] fn handler(..)
    // 捕获方法、路径，以及紧随其后的 fn 标识符。
    const attrRegex = /#\[(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["'][^\]]*\)\]/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(safe)) !== null) {
      const [, method, routePath] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const upper = method!.toUpperCase();

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'rust',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const tail = safe.slice(match.index + match[0].length);
      const fnMatch = tail.match(/\n\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (fnMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: fnMatch[1]!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'rust',
        });
      }
    }

    // Axum：.route("/path", get(h1).post(h2)…)——对 route 调用进行平衡括号扫描，
    // 然后为每个链式方法生成一个路由节点。Handler 可以带命名空间
    // （`get(module::handler)`、`get(self::list)`）；取最后一个
    // 路径段，使引用指向 fn 而非模块。
    const routeOpenRegex = /\.route\s*\(/g;
    while ((match = routeOpenRegex.exec(safe)) !== null) {
      const openIdx = safe.indexOf('(', match.index);
      if (openIdx < 0) continue;
      const closeIdx = findMatchingParen(safe, openIdx);
      if (closeIdx < 0) continue;

      const args = safe.slice(openIdx + 1, closeIdx);
      const pathMatch = args.match(/^\s*"([^"]+)"\s*,/);
      if (!pathMatch) continue;
      const routePath = pathMatch[1]!;
      const line = safe.slice(0, match.index).split('\n').length;

      const methodBody = args.slice(pathMatch[0].length);
      const methodHandlerRegex = /\b(get|post|put|patch|delete|head|options|trace)\s*\(\s*([A-Za-z_][\w:]*)/g;
      let mh: RegExpExecArray | null;
      while ((mh = methodHandlerRegex.exec(methodBody)) !== null) {
        const upper = mh[1]!.toUpperCase();
        const handler = mh[2]!.split('::').filter(Boolean).pop();
        if (!handler) continue;

        const routeNode: Node = {
          id: `route:${filePath}:${line}:${upper}:${routePath}`,
          kind: 'route',
          name: `${upper} ${routePath}`,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: 0,
          language: 'rust',
          updatedAt: now,
        };
        nodes.push(routeNode);

        references.push({
          fromNodeId: routeNode.id,
          referenceName: handler,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'rust',
        });
      }
    }

    // Actix-web builder API（主要的 actix 路由风格；属性宏在上方处理）。
    // Handler 位于 `.to(handler)` 中，而非 `get(handler)`。
    const pushActixRoute = (routePath: string, method: string, handlerExpr: string, line: number) => {
      const handler = handlerExpr.split('::').filter(Boolean).pop();
      if (!handler) return;
      const upper = method.toUpperCase();
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        language: 'rust',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handler,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'rust',
      });
    };

    // web::resource("/path") { .route(web::METHOD().to(h)) | .to(h) }——可能链式调用。
    const resourceRegex = /web::resource\s*\(\s*"([^"]+)"\s*\)/g;
    while ((match = resourceRegex.exec(safe)) !== null) {
      const routePath = match[1]!;
      const startLine = safe.slice(0, match.index).split('\n').length;
      const after = match.index + match[0].length;
      // 将 resource 的方法链范围限定到下一个 resource()，避免泄漏。
      const nextRes = safe.indexOf('web::resource', after);
      const end = Math.min(after + 500, nextRes === -1 ? safe.length : nextRes);
      const chain = safe.slice(after, end);

      const methodTo = /web::(get|post|put|patch|delete|head)\s*\(\s*\)\s*\.to\s*\(\s*([A-Za-z_][\w:]*)/g;
      let m2: RegExpExecArray | null;
      let found = false;
      while ((m2 = methodTo.exec(chain)) !== null) {
        const mLine = startLine + chain.slice(0, m2.index).split('\n').length - 1;
        pushActixRoute(routePath, m2[1]!, m2[2]!, mLine);
        found = true;
      }
      // 当没有显式动词路由时，直接 `.resource("/x").to(handler)`（所有方法）。
      if (!found) {
        const direct = chain.match(/^\s*\.to\s*\(\s*([A-Za-z_][\w:]*)/);
        if (direct) pushActixRoute(routePath, 'ANY', direct[1]!, startLine);
      }
    }

    // App 级别：.route("/path", web::METHOD().to(handler))。
    const appRouteRegex = /\.route\s*\(\s*"([^"]+)"\s*,\s*web::(get|post|put|patch|delete|head)\s*\(\s*\)\s*\.to\s*\(\s*([A-Za-z_][\w:]*)/g;
    while ((match = appRouteRegex.exec(safe)) !== null) {
      const line = safe.slice(0, match.index).split('\n').length;
      pushActixRoute(match[1]!, match[2]!, match[3]!, line);
    }

    return { nodes, references };
  },
};

// 目录模式
const HANDLER_DIRS = ['/handlers/', '/handler/', '/api/', '/routes/', '/controllers/'];
const SERVICE_DIRS = ['/services/', '/service/', '/repository/', '/domain/'];
const MODEL_DIRS = ['/models/', '/model/', '/entities/', '/entity/', '/domain/', '/types/'];

const FUNCTION_KINDS = new Set(['function']);
const SERVICE_KINDS = new Set(['struct', 'trait']);
const STRUCT_KINDS = new Set(['struct']);

/** 找到 openIdx 处 '(' 对应的 ')' 的索引，不平衡则返回 -1。 */
function findMatchingParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 通过索引查询按名称解析符号，而非扫描所有文件。
 */
function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // 优先选取框架惯用目录中的候选项
  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // 回退到任意匹配项
  return kindFiltered[0]!.id;
}

interface ModuleResolution {
  targetId: string;
  fromWorkspace: boolean;
}

function resolveModule(name: string, context: ResolutionContext): ModuleResolution | null {
  // Rust 模块可以是目录中的 mod.rs，也可以是 name.rs
  const localPaths = [`src/${name}.rs`, `src/${name}/mod.rs`];

  const workspaceCrates = getCachedCargoWorkspaceCrateMap(context);
  const cratePath = workspaceCrates.get(name);
  const workspacePaths = cratePath
    ? [`${cratePath}/src/lib.rs`, `${cratePath}/src/main.rs`]
    : [];

  const candidates: Array<{ path: string; fromWorkspace: boolean }> = [
    ...localPaths.map((path) => ({ path, fromWorkspace: false })),
    ...workspacePaths.map((path) => ({ path, fromWorkspace: true })),
  ];

  for (const { path: modPath, fromWorkspace } of candidates) {
    if (!context.fileExists(modPath)) continue;
    const nodes = context.getNodesInFile(modPath);
    const modNode = nodes.find((n) => n.kind === 'module');
    if (modNode) return { targetId: modNode.id, fromWorkspace };
    if (nodes.length > 0) return { targetId: nodes[0]!.id, fromWorkspace };
  }

  return null;
}
