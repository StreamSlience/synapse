/**
 * Laravel 框架解析器
 *
 * 处理 Laravel 专属模式的引用解析。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

/**
 * Laravel facade 到底层类的映射
 * 导出供 facade 解析时使用
 */
export const FACADE_MAPPINGS: Record<string, string> = {
  Auth: 'Illuminate\\Auth\\AuthManager',
  Cache: 'Illuminate\\Cache\\CacheManager',
  Config: 'Illuminate\\Config\\Repository',
  DB: 'Illuminate\\Database\\DatabaseManager',
  Event: 'Illuminate\\Events\\Dispatcher',
  File: 'Illuminate\\Filesystem\\Filesystem',
  Gate: 'Illuminate\\Auth\\Access\\Gate',
  Hash: 'Illuminate\\Hashing\\HashManager',
  Log: 'Illuminate\\Log\\LogManager',
  Mail: 'Illuminate\\Mail\\Mailer',
  Queue: 'Illuminate\\Queue\\QueueManager',
  Redis: 'Illuminate\\Redis\\RedisManager',
  Request: 'Illuminate\\Http\\Request',
  Response: 'Illuminate\\Http\\Response',
  Route: 'Illuminate\\Routing\\Router',
  Session: 'Illuminate\\Session\\SessionManager',
  Storage: 'Illuminate\\Filesystem\\FilesystemManager',
  URL: 'Illuminate\\Routing\\UrlGenerator',
  Validator: 'Illuminate\\Validation\\Factory',
  View: 'Illuminate\\View\\Factory',
};

export const laravelResolver: FrameworkResolver = {
  name: 'laravel',
  languages: ['php'],

  detect(context: ResolutionContext): boolean {
    // 检查 artisan 文件（Laravel 特征文件）
    return context.fileExists('artisan') || context.fileExists('app/Http/Kernel.php');
  },

  // `Controller@method` 路由引用不对应任何已声明的符号，因此 resolveOne 的
  // 预过滤器会在 resolve() 运行前将其丢弃（模式 4）。在此声明认领——
  // 与 django ORM / Rails 路由所需的钩子相同。
  claimsReference(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*Controller@\w+$/.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：Model::method() - Eloquent 静态调用
    const modelMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+)::(\w+)$/);
    if (modelMatch) {
      const [, className, methodName] = modelMatch;
      const result = resolveModelCall(className!, methodName!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 2：Facade 调用 - Auth::user()、Cache::get()
    const facadeMatch = ref.referenceName.match(/^(Auth|Cache|DB|Log|Mail|Queue|Session|Storage|Validator|Route|Request|Response)::(\w+)$/);
    if (facadeMatch) {
      // Facade 通常解析到外部 Laravel 代码
      // 标记为外部，但记录该 facade
      return null; // 外部函数，无法解析到本地节点
    }

    // 模式 3：辅助函数调用 - route()、view()、config()
    if (['route', 'view', 'config', 'env', 'app', 'abort', 'redirect', 'response', 'request', 'session', 'url', 'asset', 'mix'].includes(ref.referenceName)) {
      // 这些是 Laravel 辅助函数——外部函数
      return null;
    }

    // 模式 4：Controller 方法引用
    const controllerMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+Controller)@(\w+)$/);
    if (controllerMatch) {
      const [, controller, method] = controllerMatch;
      const result = resolveControllerMethod(controller!, method!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.php')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'php');

    // Route::METHOD('/path', handler-expr)
    // handler-expr 可以是：[Class::class, 'method'] | 'Controller@method' | Closure | Class::class
    const routeRegex = /Route::(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, method, routePath, handlerExpr] = match;
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
        language: 'php',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handlerName = extractLaravelHandler(handlerExpr!);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'php',
        });
      }
    }

    // Route::resource('name', Controller::class) / Route::apiResource('name', Controller::class)
    const resourceRegex = /Route::(resource|apiResource)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^)]+))?\)/g;
    while ((match = resourceRegex.exec(safe)) !== null) {
      const [, _fn, resourceName, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:RESOURCE:${resourceName}`,
        kind: 'route',
        name: `resource:${resourceName}`,
        qualifiedName: `${filePath}::route:${resourceName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'php',
        updatedAt: now,
      };
      nodes.push(routeNode);

      if (handlerExpr) {
        const controllerName = extractLaravelHandler(handlerExpr);
        if (controllerName) {
          references.push({
            fromNodeId: routeNode.id,
            referenceName: controllerName,
            referenceKind: 'imports',
            line,
            column: 0,
            filePath,
            language: 'php',
          });
        }
      }
    }

    return { nodes, references };
  },
};

/**
 * 解析 Laravel 路由 handler 表达式并返回需要链接的符号。
 *  - `[Class::class, 'method']`  -> `method`
 *  - `'Controller@method'`       -> `method`
 *  - `Class::class`              -> `Class`
 *  - 其他情况（闭包等）          -> null
 */
function extractLaravelHandler(expr: string): string | null {
  const trimmed = expr.trim();
  const short = (s: string) => s.split('\\').pop()!; // 去除命名空间

  // [Class::class, 'method'] → `Class@method`（精确——保留 controller，避免
  // `index`/`show` 等常见 action 名称被名称匹配解析到错误的 controller）。
  const tupleMatch = trimmed.match(/^\[\s*([A-Za-z_\\][\w\\]*)::class\s*,\s*['"]([^'"]+)['"]\s*\]/);
  if (tupleMatch) return `${short(tupleMatch[1]!)}@${tupleMatch[2]!}`;

  // 'Controller@method'（可能带命名空间）→ `Controller@method`
  const atMatch = trimmed.match(/^['"]([^'"@]+)@([^'"]+)['"]$/);
  if (atMatch) return `${short(atMatch[1]!)}@${atMatch[2]!}`;

  // Class::class（Route::resource controller）→ `Class`
  const classMatch = trimmed.match(/^([A-Za-z_\\][\w\\]*)::class/);
  if (classMatch) return short(classMatch[1]!);

  return null;
}

/**
 * 解析 Model::method() 调用
 */
function resolveModelCall(
  className: string,
  methodName: string,
  context: ResolutionContext
): string | null {
  // 先尝试 app/Models/（Laravel 8+）
  let modelPath = `app/Models/${className}.php`;
  if (context.fileExists(modelPath)) {
    const nodes = context.getNodesInFile(modelPath);
    // 在该类中查找方法
    const methodNode = nodes.find(
      (n) => n.kind === 'method' && n.name === methodName
    );
    if (methodNode) {
      return methodNode.id;
    }
    // 若方法未找到，返回类本身
    const classNode = nodes.find(
      (n) => n.kind === 'class' && n.name === className
    );
    if (classNode) {
      return classNode.id;
    }
  }

  // 尝试 app/（Laravel 7 及以下）
  modelPath = `app/${className}.php`;
  if (context.fileExists(modelPath)) {
    const nodes = context.getNodesInFile(modelPath);
    const methodNode = nodes.find(
      (n) => n.kind === 'method' && n.name === methodName
    );
    if (methodNode) {
      return methodNode.id;
    }
    const classNode = nodes.find(
      (n) => n.kind === 'class' && n.name === className
    );
    if (classNode) {
      return classNode.id;
    }
  }

  return null;
}

/**
 * 解析 Controller@method 引用
 */
function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  // 尝试 app/Http/Controllers/
  const controllerPath = `app/Http/Controllers/${controller}.php`;
  if (context.fileExists(controllerPath)) {
    const nodes = context.getNodesInFile(controllerPath);
    const methodNode = nodes.find(
      (n) => n.kind === 'method' && n.name === method
    );
    if (methodNode) {
      return methodNode.id;
    }
  }

  // 对命名空间 controller 尝试基于名称的查找
  const controllerCandidates = context.getNodesByName(controller);
  for (const ctrl of controllerCandidates) {
    if (ctrl.kind === 'class' && ctrl.filePath.includes('Controllers')) {
      const nodesInFile = context.getNodesInFile(ctrl.filePath);
      const methodNode = nodesInFile.find(
        (n) => n.kind === 'method' && n.name === method
      );
      if (methodNode) {
        return methodNode.id;
      }
    }
  }

  return null;
}
