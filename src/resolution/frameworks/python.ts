/**
 * Python 框架解析器
 *
 * 处理 Django、Flask 和 FastAPI 模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolutionContext, FrameworkExtractionResult } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const djangoResolver: FrameworkResolver = {
  name: 'django',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && requirements.toLowerCase().includes('django')) return true;
    const setup = context.readFile('setup.py');
    if (setup && setup.toLowerCase().includes('django')) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.toLowerCase().includes('django')) return true;
    return context.fileExists('manage.py');
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('Model') || /^[A-Z][a-z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, MODEL_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('View') || ref.referenceName.endsWith('ViewSet')) {
      const result = resolveByNameAndKind(ref.referenceName, VIEW_KINDS, VIEW_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Form')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, FORM_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    // ORM 动态分发：QuerySet._fetch_all（及其同级方法）调用
    // `self._iterable_class(self)`——运行时分发到 iterable 类
    // （默认为 ModelIterable），其 __iter__ 运行 SQL 编译器。静态
    // 解析无法解析属性调用，因此留下了未解析的 `_iterable_class` 引用，
    // 在 QuerySet→编译器调用链中造成断口。将其桥接到 ModelIterable.__iter__，
    // 使流程在图中真实存在。
    if (ref.referenceName === '_iterable_class') {
      const target = resolveModelIterableIter(context);
      if (target) return { original: ref, targetNodeId: target, confidence: 0.7, resolvedBy: 'framework' };
    }
    return null;
  },

  // 让两种引用形式通过 resolveOne 的"无可能匹配"预过滤器，从而到达解析阶段：
  // ORM 动态分发的 `_iterable_class`（QuerySet 属性，而非已声明符号），以及
  // Django 的 `include('app.urls')` 模块路径——一个无符号/无导入可匹配的点分
  // 模块名，解析（resolvePythonAbsoluteModule）随后将其映射到对应的 `urls.py`
  // 文件，使被包含的 URLconf 记录对根 urlconf 的依赖。
  claimsReference(name) {
    return name === '_iterable_class' || name.endsWith('.urls');
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'python');

    // path('url', handler, name=...) / re_path(r'...', handler) / url(r'...', handler)
    // 捕获组：1=函数名，2=url 字符串，3=处理器表达式
    // 处理器表达式可包含一对平衡括号（如 View.as_view()、include('x.y')）
    const routeRegex = /\b(path|re_path|url)\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([\w.]+(?:\s*\([^)]*\))?)/g;

    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, _fn, urlPath, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${urlPath}`,
        kind: 'route',
        name: urlPath!,
        qualifiedName: `${filePath}::route:${urlPath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'python',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handler = handlerExpr!.trim();
      const target = resolveHandlerName(handler);
      if (target) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: target.name,
          referenceKind: target.kind,
          line,
          column: 0,
          filePath,
          language: 'python',
        });
      }
    }

    // DRF 路由注册：`router.register(r'articles', ArticleViewSet)` →
    // 路由 → ViewSet 类（核心 CRUD 端点，path()/url() 无法捕获）。
    // 第一个 STRING 参数将其与 `admin.site.register(Model, Admin)`
    // （第一个参数是模型类而非字符串）区分开；第二个参数的 View/ViewSet 后缀
    // 限定其仅匹配 DRF viewset。
    const routerRegex = /\.register\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([\w.]+)/g;
    while ((match = routerRegex.exec(safe)) !== null) {
      const prefix = match[1]!.replace(/^\^|\/?\$$/g, '');
      const viewset = match[2]!.split('.').pop()!;
      if (!/View(Set)?$/.test(viewset)) continue;
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:VIEWSET:${prefix}`,
        kind: 'route',
        name: `VIEWSET /${prefix}`,
        qualifiedName: `${filePath}::route:${prefix}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
        language: 'python', updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: viewset,
        referenceKind: 'references',
        line, column: 0, filePath, language: 'python',
      });
    }

    return { nodes, references };
  },
};

/**
 * 查找 ModelIterable.__iter__——QuerySet 通过 `self._iterable_class(self)` 调用的
 * 默认 iterable。其 __iter__ 静态调用 SQL 编译器，因此在此桥接动态分发，
 * 可闭合 QuerySet→SQL 调用链。
 * （过度近似为默认 iterable；.values()/.values_list() 会切换到其他
 * BaseIterable 子类，但 ModelIterable 是规范路径。）
 */
function resolveModelIterableIter(context: ResolutionContext): string | null {
  const cls = context.getNodesByName('ModelIterable').find((n) => n.kind === 'class');
  if (!cls) return null;
  const iter = context.getNodesByName('__iter__').find(
    (n) => n.filePath === cls.filePath && n.startLine >= cls.startLine && n.startLine <= cls.endLine
  );
  return iter ? iter.id : null;
}

/**
 * 解析 Django URL 处理器表达式，返回要链接的符号/模块。
 * 对于无法可靠链接的形式（如 lambda），返回 null。
 */
function resolveHandlerName(expr: string): { name: string; kind: 'references' | 'imports' } | null {
  // include('module.path')
  const includeMatch = expr.match(/^include\s*\(\s*['"]([^'"]+)['"]/);
  if (includeMatch) return { name: includeMatch[1]!, kind: 'imports' };

  // 去掉尾部的 .as_view(...) 或 .as_view()
  let head = expr.replace(/\.as_view\s*\([^)]*\)\s*$/, '');
  // 去掉其他尾部方法调用
  head = head.replace(/\.\w+\s*\([^)]*\)\s*$/, '');

  const dotted = head.split('.').filter(Boolean);
  if (dotted.length === 0) return null;
  const last = dotted[dotted.length - 1]!;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return null;

  return { name: last, kind: 'references' };
}

export const flaskResolver: FrameworkResolver = {
  name: 'flask',
  languages: ['python'],

  detect(context) {
    for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']) {
      const c = context.readFile(f);
      if (c && /\bflask\b/i.test(c)) return true;
    }
    // 任何入口文件（根目录或子目录，如 conduit/app.py），只要导入了 flask
    // 并实例化了 Flask(...)——涵盖 Flask(__name__)、Flask(__name__.split…)
    // 以及应用工厂模式。限定为以入口文件命名的文件。
    const entrypoints = context
      .getAllFiles()
      .filter((f) => /(?:^|\/)(app|application|main|wsgi|__init__)\.py$/.test(f))
      .slice(0, 50);
    for (const f of entrypoints) {
      const c = context.readFile(f);
      if (c && /\bFlask\s*\(/.test(c) && /\bimport\s+flask\b|\bfrom\s+flask\b/.test(c)) return true;
    }
    return false;
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('_bp') || ref.referenceName.endsWith('_blueprint')) {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, [], context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };
    const safe = stripCommentsForRegex(content, 'python');
    const decorator = extractDecoratorRoutes(filePath, safe, {
      // Flask：@x.route('/path', methods=[...] | (...)) — 处理器是下一个
      // `def`，允许中间有其他装饰器（@login_required）和堆叠的 @x.route() 行。
      // methods 可以是列表或元组（methods=('GET',)）。
      decoratorRegex: /@(\w+)\.route\s*\(\s*['"]([^'"]*)['"](?:\s*,\s*methods\s*=\s*[[(]([^\])]+)[\])])?\s*\)/g,
      defaultMethod: 'GET',
      methodFromGroup: 3,
      pathGroup: 2,
      findHandler: true,
      language: 'python',
    });
    const restful = extractFlaskRestful(filePath, safe);
    return {
      nodes: [...decorator.nodes, ...restful.nodes],
      references: [...decorator.references, ...restful.references],
    };
  },
};

export const fastapiResolver: FrameworkResolver = {
  name: 'fastapi',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && /\bfastapi\b/i.test(requirements)) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && /\bfastapi\b/i.test(pyproject)) return true;
    for (const file of ['app.py', 'main.py', 'api.py']) {
      const content = context.readFile(file);
      if (content && content.includes('FastAPI(')) return true;
    }
    return false;
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('_router') || ref.referenceName === 'router') {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, ROUTER_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.startsWith('get_') || ref.referenceName.startsWith('Depends')) {
      const result = resolveByNameAndKind(ref.referenceName, FUNCTION_KINDS, DEP_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.75, resolvedBy: 'framework' };
    }
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };
    return extractDecoratorRoutes(filePath, stripCommentsForRegex(content, 'python'), {
      // FastAPI：@x.METHOD('/path') -> 下一个 def 行上的处理器。路径可以为
      // 空（""），用于挂载到路由器/前缀根路径的路由。
      decoratorRegex: /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]*)['"]/g,
      defaultMethod: '',
      methodGroup: 2,
      pathGroup: 3,
      findHandler: true,
      language: 'python',
    });
  },
};

interface DecoratorRouteOpts {
  decoratorRegex: RegExp;
  defaultMethod: string;
  methodGroup?: number;
  methodFromGroup?: number; // methods=[...] list
  pathGroup: number;
  handlerGroup?: number;
  findHandler?: boolean;
  language: 'python';
}

function extractDecoratorRoutes(filePath: string, content: string, opts: DecoratorRouteOpts): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  let match: RegExpExecArray | null;
  while ((match = opts.decoratorRegex.exec(content)) !== null) {
    const routePath = match[opts.pathGroup];
    let method = opts.defaultMethod;
    if (opts.methodGroup && match[opts.methodGroup]) {
      method = match[opts.methodGroup]!.toUpperCase();
    } else if (opts.methodFromGroup && match[opts.methodFromGroup]) {
      const m = match[opts.methodFromGroup]!.match(/['"]([A-Z]+)['"]/i);
      if (m) method = m[1]!.toUpperCase();
    }
    const line = content.slice(0, match.index).split('\n').length;
    const name = method ? `${method} ${routePath || '/'}` : (routePath || '/');
    const routeNode: Node = {
      id: `route:${filePath}:${line}:${method}:${routePath}`,
      kind: 'route',
      name,
      qualifiedName: `${filePath}::${method}:${routePath}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: match[0].length,
      language: opts.language,
      updatedAt: now,
    };
    nodes.push(routeNode);

    let handlerName: string | undefined;
    if (opts.handlerGroup && match[opts.handlerGroup]) {
      handlerName = match[opts.handlerGroup];
    } else if (opts.findHandler) {
      const tail = content.slice(match.index + match[0].length);
      const defMatch = tail.match(/\n\s*(?:async\s+)?def\s+(\w+)/);
      if (defMatch) handlerName = defMatch[1];
    }
    if (handlerName) {
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerName,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      });
    }
  }
  return { nodes, references };
}

/**
 * Flask-RESTful：`api.add_resource(ResourceClass, '/path'[, '/path2'])`
 * （以及 redash 的 `add_org_resource` 等变体）。ResourceClass 持有各 HTTP
 * 动词方法（get/post/…），因此路由引用该类——其动词方法通过类来解析为处理器。
 * method 为 ANY（由类决定它处理哪些动词）。
 */
function extractFlaskRestful(filePath: string, safe: string): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const re = /\.add\w*[Rr]esource\s*\(\s*(\w+)\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(safe)) !== null) {
    const className = m[1]!;
    const paths = (m[2]!.match(/['"]([^'"]+)['"]/g) || []).map((s) => s.slice(1, -1));
    const line = safe.slice(0, m.index).split('\n').length;
    for (const routePath of paths) {
      const routeNode: Node = {
        id: `route:${filePath}:${line}:ANY:${routePath}`,
        kind: 'route',
        name: `ANY ${routePath}`,
        qualifiedName: `${filePath}::ANY:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        language: 'python',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: className,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      });
    }
  }
  return { nodes, references };
}

// 目录模式
const MODEL_DIRS = ['models', 'app/models', 'src/models'];
const VIEW_DIRS = ['views', 'app/views', 'src/views', 'api/views'];
const FORM_DIRS = ['forms', 'app/forms', 'src/forms'];
const ROUTER_DIRS = ['/routers/', '/api/', '/routes/', '/endpoints/'];
const DEP_DIRS = ['/dependencies/', '/deps/', '/core/'];

const CLASS_KINDS = new Set(['class']);
const VIEW_KINDS = new Set(['class', 'function']);
const VARIABLE_KINDS = new Set(['variable']);
const FUNCTION_KINDS = new Set(['function']);

/**
 * 使用索引查询按名称解析符号，而非扫描所有文件。
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

  // 优先选择框架约定目录中的候选
  if (preferredDirPatterns.length > 0) {
    const preferred = kindFiltered.filter((n) =>
      preferredDirPatterns.some((d) => n.filePath.includes(d))
    );
    if (preferred.length > 0) return preferred[0]!.id;
  }

  // 回退到任意匹配
  return kindFiltered[0]!.id;
}
