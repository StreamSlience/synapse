/**
 * Ruby 框架解析器
 *
 * 处理 Ruby on Rails 模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const railsResolver: FrameworkResolver = {
  name: 'rails',
  languages: ['ruby'],

  // `controller#action` 路由引用未对应任何已声明的符号，resolveOne 的
  // 预过滤器会在 resolve() 执行前将其丢弃。在此认领（类似 django 的
  // `_iterable_class` 钩子），使其进入 Pattern 0。
  claimsReference(name: string): boolean {
    return /^[\w/]+#\w+$/.test(name);
  },

  detect(context: ResolutionContext): boolean {
    // 检查 Gemfile 中是否包含 rails
    const gemfile = context.readFile('Gemfile');
    if (gemfile && gemfile.includes("'rails'")) {
      return true;
    }

    // 检查 config/application.rb（Rails 特征文件）
    if (context.fileExists('config/application.rb')) {
      return true;
    }

    // 检查典型的 Rails 目录结构
    return (
      context.fileExists('app/controllers/application_controller.rb') ||
      context.fileExists('config/routes.rb')
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 0：路由 action `controller#action`（来自 RESTful `resources` 或显式路由）
    // → 对应控制器中的 action 方法。精确匹配——避免裸 `action` 的歧义
    // （每个控制器都有 `index`/`show`）。
    const ca = ref.referenceName.match(/^([\w/]+)#(\w+)$/);
    if (ca) {
      const result = resolveControllerAction(ca[1]!, ca[2]!, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' };
      }
      return null;
    }

    // Pattern 1：Model 引用（ActiveRecord）
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveModel(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2：Controller 引用
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveController(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3：Helper 引用
    if (ref.referenceName.endsWith('Helper')) {
      const result = resolveHelper(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4：Service/Job 引用
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Job')) {
      const result = resolveService(ref.referenceName, context);
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
    if (!filePath.endsWith('.rb')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'ruby');

    // get/post/put/patch/delete/match '/path', to: 'controller#action'
    // 也支持：get '/path' => 'controller#action'
    const routeRegex = /\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]\s*(?:,\s*to:\s*|=>\s*)['"]([^#'"]+)#([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, method, routePath, ctrl, action] = match;
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
        language: 'ruby',
        updatedAt: now,
      };
      nodes.push(routeNode);

      references.push({
        fromNodeId: routeNode.id,
        referenceName: `${ctrl}#${action}`, // 精确的 controller#action，而非裸 action
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'ruby',
      });
    }

    // RESTful 资源：`resources :articles` / `resource :user`（Rails 路由中的主流写法）
    // 为每个 REST 动词生成一个 controller action。旧解析器只识别显式的
    // `get '/x' => 'c#a'` 路由，导致资源路由的应用中 ZERO 个路由节点。
    // 将每个资源展开为其 actions → `controller#action` 引用。
    const resRegex = /\b(resources?)\s+:(\w+)([^\n]*)/g;
    while ((match = resRegex.exec(safe)) !== null) {
      const plural = match[1] === 'resources';
      const resName = match[2]!;
      const tail = match[3] || '';
      let actions = plural ? PLURAL_ACTIONS : SINGULAR_ACTIONS;
      const only = tail.match(/only:\s*\[([^\]]*)\]/);
      const except = tail.match(/except:\s*\[([^\]]*)\]/);
      const symList = (s: string) => new Set(s.split(',').map((x) => x.trim().replace(/^:/, '')));
      if (only) { const s = symList(only[1]!); actions = actions.filter((a) => s.has(a)); }
      else if (except) { const s = symList(except[1]!); actions = actions.filter((a) => !s.has(a)); }
      // `resources :articles` → ArticlesController；`resource :user` → UsersController。
      const ctrl = plural ? resName : pluralize(resName);
      const line = safe.slice(0, match.index).split('\n').length;
      for (const action of actions) {
        const spec = RESTFUL_ROUTES[action]!;
        const path = spec.path(resName);
        const routeNode: Node = {
          id: `route:${filePath}:${line}:${spec.method}:${ctrl}#${action}`,
          kind: 'route',
          name: `${spec.method} ${path}`,
          qualifiedName: `${filePath}::route:${ctrl}#${action}`,
          filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
          language: 'ruby', updatedAt: now,
        };
        nodes.push(routeNode);
        references.push({
          fromNodeId: routeNode.id,
          referenceName: `${ctrl}#${action}`,
          referenceKind: 'references',
          line, column: 0, filePath, language: 'ruby',
        });
      }
    }

    return { nodes, references };
  },
};

// 辅助函数

// RESTful action → HTTP 动词 + 路径。`resources` 获取全部七个；单数形式
// `resource` 省略 `index`。
const RESTFUL_ROUTES: Record<string, { method: string; path: (r: string) => string }> = {
  index:   { method: 'GET',    path: (r) => `/${r}` },
  create:  { method: 'POST',   path: (r) => `/${r}` },
  new:     { method: 'GET',    path: (r) => `/${r}/new` },
  show:    { method: 'GET',    path: (r) => `/${r}/:id` },
  edit:    { method: 'GET',    path: (r) => `/${r}/:id/edit` },
  update:  { method: 'PATCH',  path: (r) => `/${r}/:id` },
  destroy: { method: 'DELETE', path: (r) => `/${r}/:id` },
};
const PLURAL_ACTIONS = ['index', 'create', 'new', 'show', 'edit', 'update', 'destroy'];
const SINGULAR_ACTIONS = ['create', 'new', 'show', 'edit', 'update', 'destroy'];

/** 简易 ActiveSupport 风格的复数化——覆盖常见资源名。 */
function pluralize(w: string): string {
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(w)) return w + 'es';
  return w + 's';
}

/** snake_case → CamelCase（`user_profiles` → `UserProfiles`）。 */
function camelize(s: string): string {
  return s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/** 将 `controller#action` 路由引用解析为对应控制器中的 action 方法。 */
function resolveControllerAction(ctrlPath: string, action: string, context: ResolutionContext): string | null {
  // Rails 约定：`articles` → app/controllers/articles_controller.rb。
  const direct = `app/controllers/${ctrlPath}_controller.rb`;
  if (context.fileExists(direct)) {
    const m = context.getNodesInFile(direct).find((n) => (n.kind === 'method' || n.kind === 'function') && n.name === action);
    if (m) return m.id;
  }
  // 回退：按名称查找控制器类，再在其文件中找到对应的 action 方法。
  const cls = camelize(ctrlPath.split('/').pop()!) + 'Controller';
  for (const ctrl of context.getNodesByName(cls).filter((n) => n.kind === 'class')) {
    const m = context.getNodesInFile(ctrl.filePath).find((n) => (n.kind === 'method' || n.kind === 'function') && n.name === action);
    if (m) return m.id;
  }
  return null;
}

function resolveModel(name: string, context: ResolutionContext): string | null {
  // 先尝试直接文件路径查找（Rails 约定：CamelCase → snake_case.rb）
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const possiblePaths = [
    `app/models/${snakeName}.rb`,
    `app/models/concerns/${snakeName}.rb`,
  ];

  for (const modelPath of possiblePaths) {
    if (context.fileExists(modelPath)) {
      const nodes = context.getNodesInFile(modelPath);
      const modelNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (modelNode) {
        return modelNode.id;
      }
    }
  }

  // 回退到按名称查找
  const candidates = context.getNodesByName(name);
  const modelNode = candidates.find(
    (n) => n.kind === 'class' && n.filePath.includes('app/models/')
  );
  if (modelNode) return modelNode.id;

  return null;
}

function resolveController(name: string, context: ResolutionContext): string | null {
  // 先尝试直接文件路径查找
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const possiblePaths = [
    `app/controllers/${snakeName}.rb`,
    `app/controllers/api/${snakeName}.rb`,
    `app/controllers/api/v1/${snakeName}.rb`,
  ];

  for (const controllerPath of possiblePaths) {
    if (context.fileExists(controllerPath)) {
      const nodes = context.getNodesInFile(controllerPath);
      const controllerNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (controllerNode) {
        return controllerNode.id;
      }
    }
  }

  // 回退到按名称查找
  const candidates = context.getNodesByName(name);
  const controllerNode = candidates.find(
    (n) => n.kind === 'class' && n.filePath.includes('controllers/')
  );
  if (controllerNode) return controllerNode.id;

  return null;
}

function resolveHelper(name: string, context: ResolutionContext): string | null {
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const helperPath = `app/helpers/${snakeName}.rb`;

  if (context.fileExists(helperPath)) {
    const nodes = context.getNodesInFile(helperPath);
    const helperNode = nodes.find(
      (n) => n.kind === 'module' && n.name === name
    );
    if (helperNode) {
      return helperNode.id;
    }
  }

  return null;
}

function resolveService(name: string, context: ResolutionContext): string | null {
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const possiblePaths = [
    `app/services/${snakeName}.rb`,
    `app/jobs/${snakeName}.rb`,
    `app/workers/${snakeName}.rb`,
  ];

  for (const servicePath of possiblePaths) {
    if (context.fileExists(servicePath)) {
      const nodes = context.getNodesInFile(servicePath);
      const serviceNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (serviceNode) {
        return serviceNode.id;
      }
    }
  }

  return null;
}
