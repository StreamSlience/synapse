# 框架解析器 `extract()` 接线实现计划

> **面向智能体工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现本计划。步骤使用复选框（`- [ ]`）语法进行追踪。

**目标：** 接通死代码 `FrameworkResolver.extractNodes` 钩子，让每个框架解析器都能向图中贡献路由节点和路由到处理器的边，并将所有 13 个现有框架解析器更新为正确使用该钩子。

**架构：** 将未使用的 `extractNodes?(filePath, content): Node[]` 钩子替换为单一的 `extract?(filePath, content): { nodes, references }` 方法。在提取阶段（tree-sitter 解析文件后）对框架语言匹配的每个文件调用一次。提取的节点与 tree-sitter 节点一起存入 DB；提取的引用流入现有的未解析引用管道，由现有的名称匹配器 / 导入解析器 / 框架 `resolve()` 机制创建最终的边。最终效果：`path('/users', UserListView.as_view())` 产生一个 `route` 节点，通过 `references` 边链接到 `UserListView` 类节点——对 Flask、FastAPI、Express、Rails、Laravel、Spring、Gin、Axum、ASP.NET、Vapor、React Router 和 SvelteKit 同样成立。

**技术栈：** TypeScript、vitest、tree-sitter（现有）、better-sqlite3（现有）。无新依赖。

---

## 背景

目前，每个 `FrameworkResolver` 都带有 `extractNodes?(filePath, content)` 方法（express、laravel、python/django、python/flask、python/fastapi、ruby/rails、java/spring、go、rust、csharp、swift × 3、react、svelte）。但它们从未被调用过。实证证明：在 `src/` 中 grep `extractNodes`，只找到一处引用——`src/resolution/types.ts:99` 处的接口定义。因此，实际上图中没有任何 `route` 类型的节点，路由文件中的 URL 条目与其视图/控制器/处理器之间的链接也不存在。

另外，Django 提取器的正则表达式在第 2 组中捕获了视图名，但 `src/resolution/frameworks/python.ts` 中的解构却将其丢弃了，所以即使钩子存活，也无法将路由链接到视图。大多数框架中都存在类似的结构性 bug。

本计划一次性修复这两个问题。

## 文件结构

- `src/resolution/types.ts` — 在 `FrameworkResolver` 中添加 `extract?()`；移除 `extractNodes?()`。
- `src/resolution/frameworks/index.ts` — 保留 `detectFrameworks` 签名；添加 `getApplicableFrameworks(language)` 辅助函数。
- `src/resolution/frameworks/python.ts` — 重写 Django/Flask/FastAPI 提取器。
- `src/resolution/frameworks/express.ts` / `laravel.ts` / `ruby.ts` / `java.ts` / `go.ts` / `rust.ts` / `csharp.ts` / `swift.ts` / `react.ts` / `svelte.ts` — 迁移到新接口。
- `src/extraction/index.ts` — 在 `ExtractionOrchestrator.indexAll` 的每文件 tree-sitter 解析后插入框架提取。
- `src/extraction/parse-worker.ts` — 将检测到的框架名称传入 worker，使 worker 能自行调用框架提取器（因为主线程的 `extractFromSource` 和 worker 线程的解析路径都必须覆盖此逻辑）。
- `__tests__/frameworks.test.ts` — 新建。每个框架一个 `describe`，检查代表性 fixture 是否产生预期的 `{nodes, references}`。
- `__tests__/frameworks-integration.test.ts` — 新建。端到端测试：索引一个小型 Django 项目 fixture，断言从 `urlpatterns` 条目到 `UserListView` 存在 `route -> class` 边，边类型为 `references`。

拆分为两个测试文件的理由：单元测试是确定性的字符串输入 / 数组输出，运行只需毫秒；集成测试启动 Synapse DB，速度较慢，但能提供最强的行为保证。

## 范围说明

本计划不将 Django 提取从正则表达式迁移到 AST。正则方法对本 PR 所针对的常见形式（`path(...)`、`url(...)`、`re_path(...)`、`include(...)`、DRF `router.register(...)`、CBV `.as_view()`、点分模块路径）已经足够。后续 PR 可以使用 tree-sitter 现有的 Python 解析器将正则换成 AST 遍历，那是更大的改动，不应阻塞本 PR。

---

## 任务 1：更新 `FrameworkResolver` 接口

**文件：**
- 修改：`src/resolution/types.ts:88-100`

- [ ] **步骤 1：编写失败测试**

创建 `__tests__/frameworks.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import type { FrameworkResolver, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

describe('FrameworkResolver.extract interface', () => {
  it('extract() returns { nodes, references }', () => {
    const resolver: FrameworkResolver = {
      name: 'fake',
      detect: () => true,
      resolve: () => null,
      languages: ['python'],
      extract: (_filePath: string, _content: string) => ({
        nodes: [] as Node[],
        references: [] as UnresolvedRef[],
      }),
    };
    const result = resolver.extract!('foo.py', '');
    expect(result).toEqual({ nodes: [], references: [] });
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

运行：`npx vitest run __tests__/frameworks.test.ts`
预期结果：FAIL — `extract` 不是 `FrameworkResolver` 的属性；`languages` 也不是 `FrameworkResolver` 的属性。

- [ ] **步骤 3：更新接口**

将 `src/resolution/types.ts:88-100` 替换为：

```typescript
/**
 * Result of framework-specific file extraction.
 */
export interface FrameworkExtractionResult {
  /** Framework-specific nodes (e.g. routes) */
  nodes: Node[];
  /** Framework-specific unresolved references (e.g. route -> handler) */
  references: UnresolvedRef[];
}

/**
 * Framework-specific resolver
 */
export interface FrameworkResolver {
  /** Framework name */
  name: string;
  /** Languages this framework applies to. If omitted, applies to all languages. */
  languages?: Language[];
  /** Detect if project uses this framework (project-level, called once at startup) */
  detect(context: ResolutionContext): boolean;
  /** Resolve a reference using framework-specific patterns */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  /**
   * Extract framework-specific nodes and references from a file.
   *
   * Returns route nodes, middleware nodes, etc., plus unresolved references
   * that link those nodes to handlers (view classes, controller methods,
   * included modules). Unresolved references flow into the normal resolution
   * pipeline; the framework's own `resolve()` is one of the strategies tried.
   */
  extract?(filePath: string, content: string): FrameworkExtractionResult;
}
```

- [ ] **步骤 4：运行测试，确认通过**

运行：`npx vitest run __tests__/frameworks.test.ts`
预期结果：PASS。

- [ ] **步骤 5：运行类型检查，检测下游破坏**

运行：`npx tsc --noEmit`
预期结果：FAIL — 每个 `src/resolution/frameworks/*.ts` 都会因 `extractNodes` 不存在于 `FrameworkResolver` 而报错。这是预期的；后续任务会逐一修复。

- [ ] **步骤 6：提交**

```bash
git add src/resolution/types.ts __tests__/frameworks.test.ts
git commit -m "feat(resolution): replace extractNodes with extract() returning nodes and references"
```

---

## 任务 2：添加 `getApplicableFrameworks` 辅助函数并保持检测正确

**文件：**
- 修改：`src/resolution/frameworks/index.ts`

- [ ] **步骤 1：编写失败测试**

追加到 `__tests__/frameworks.test.ts`：

```typescript
import { getApplicableFrameworks } from '../src/resolution/frameworks';
import type { FrameworkResolver } from '../src/resolution/types';

describe('getApplicableFrameworks', () => {
  const pyFw: FrameworkResolver = { name: 'py', languages: ['python'], detect: () => true, resolve: () => null };
  const jsFw: FrameworkResolver = { name: 'js', languages: ['javascript', 'typescript'], detect: () => true, resolve: () => null };
  const anyFw: FrameworkResolver = { name: 'any', detect: () => true, resolve: () => null };

  it('filters by language', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'python');
    expect(result.map(r => r.name)).toEqual(['py', 'any']);
  });

  it('returns anyFw-only when language has no matches', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'rust');
    expect(result.map(r => r.name)).toEqual(['any']);
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

运行：`npx vitest run __tests__/frameworks.test.ts`
预期结果：FAIL — `getApplicableFrameworks` 未导出。

- [ ] **步骤 3：在 `src/resolution/frameworks/index.ts` 中添加辅助函数**

在现有 `detectFrameworks` 函数之后添加：

```typescript
import type { Language } from '../../types';

/**
 * Filter a list of detected frameworks down to ones that apply to a given language.
 * Frameworks without an explicit `languages` list are treated as universal.
 */
export function getApplicableFrameworks(
  detected: FrameworkResolver[],
  language: Language
): FrameworkResolver[] {
  return detected.filter(
    (fw) => !fw.languages || fw.languages.includes(language)
  );
}
```

- [ ] **步骤 4：运行测试，确认通过**

运行：`npx vitest run __tests__/frameworks.test.ts`
预期结果：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/resolution/frameworks/index.ts __tests__/frameworks.test.ts
git commit -m "feat(resolution): add getApplicableFrameworks helper for per-language dispatch"
```

---

## 任务 3：将 Django 解析器迁移到带有正确路由→视图引用的新 `extract()`

**文件：**
- 修改：`src/resolution/frameworks/python.ts`（djangoResolver 部分，约第 1-100 行）

- [ ] **步骤 1：编写失败测试**

追加到 `__tests__/frameworks.test.ts`：

```typescript
import { djangoResolver } from '../src/resolution/frameworks/python';

describe('djangoResolver.extract', () => {
  it('extracts route node and reference for path() with CBV.as_view()', () => {
    const src = `
from django.urls import path
from users.views import UserListView

urlpatterns = [
    path('users/', UserListView.as_view(), name='user-list'),
]
`;
    const { nodes, references } = djangoResolver.extract!('users/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('users/');
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('UserListView');
    expect(references[0].referenceKind).toBe('references');
    expect(references[0].fromNodeId).toBe(nodes[0].id);
  });

  it('extracts route for path() with dotted module.Class.as_view()', () => {
    const src = `from django.urls import path\nfrom api.v1 import views as api_v1_views\nurlpatterns = [path('api/', api_v1_views.UserListView.as_view())]\n`;
    const { nodes, references } = djangoResolver.extract!('api/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(references[0].referenceName).toBe('UserListView');
  });

  it('extracts route for path() with bare function view', () => {
    const src = `from django.urls import path\nurlpatterns = [path('home/', home_view, name='home')]\n`;
    const { nodes, references } = djangoResolver.extract!('home/urls.py', src);
    expect(references[0].referenceName).toBe('home_view');
  });

  it('extracts route for path() with include()', () => {
    const src = `from django.urls import path, include\nurlpatterns = [path('api/', include('api.urls'))]\n`;
    const { nodes, references } = djangoResolver.extract!('root/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(references[0].referenceName).toBe('api.urls');
    expect(references[0].referenceKind).toBe('imports');
  });

  it('extracts routes for re_path and url', () => {
    const src = `from django.urls import re_path, url\nurlpatterns = [re_path(r'^users/$', UserView), url(r'^old/$', OldView)]\n`;
    const { nodes } = djangoResolver.extract!('legacy/urls.py', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.name)).toEqual(['^users/$', '^old/$']);
  });

  it('returns empty result for a non-urls.py python file', () => {
    const src = `def foo(): return 1\n`;
    const { nodes, references } = djangoResolver.extract!('views.py', src);
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

运行：`npx vitest run __tests__/frameworks.test.ts -t djangoResolver`
预期结果：FAIL — `djangoResolver.extract` 为 undefined。

- [ ] **步骤 3：重写 djangoResolver**

将 `src/resolution/frameworks/python.ts` 中的 `djangoResolver` 对象（约第 7-100 行）替换为：

```typescript
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
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // path('url', handler, name=...) / re_path(r'...', handler) / url(r'...', handler)
    // Capture groups: 1=function name, 2=url string, 3=rest of line up to closing )
    const routeRegex = /\b(path|re_path|url)\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([^)]*?)(?:\)|,\s*name=)/g;

    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(content)) !== null) {
      const [, _fn, urlPath, handlerExpr] = match;
      const line = content.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${urlPath}`,
        kind: 'route',
        name: urlPath,
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

      const handler = handlerExpr.trim();
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

    return { nodes, references };
  },
};

/**
 * Parse a Django URL handler expression and return the symbol/module to link.
 *
 * Returns null for shapes we can't confidently link (e.g. lambdas).
 */
function resolveHandlerName(expr: string): { name: string; kind: 'references' | 'imports' } | null {
  // include('module.path') / include("module.path")
  const includeMatch = expr.match(/^include\s*\(\s*['"]([^'"]+)['"]/);
  if (includeMatch) return { name: includeMatch[1], kind: 'imports' };

  // Strip trailing .as_view(...) or .as_view call
  let head = expr.replace(/\.as_view\s*\([^)]*\)\s*$/, '');

  // Drop a trailing method call like .some_method()
  head = head.replace(/\.\w+\s*\([^)]*\)\s*$/, '');

  // Now head should be either a bare name or a dotted path. Take the last segment.
  const dotted = head.split('.').filter(Boolean);
  if (dotted.length === 0) return null;
  const last = dotted[dotted.length - 1];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return null;

  return { name: last, kind: 'references' };
}
```

同时确保文件顶部导入了 `UnresolvedRef` 和 `Node`：

```typescript
import type { FrameworkResolver, UnresolvedRef } from '../types';
import type { Node } from '../../types';
```

- [ ] **步骤 4：运行测试，确认通过**

运行：`npx vitest run __tests__/frameworks.test.ts -t djangoResolver`
预期结果：PASS（6 个测试）。

- [ ] **步骤 5：提交**

```bash
git add src/resolution/frameworks/python.ts __tests__/frameworks.test.ts
git commit -m "feat(django): emit route nodes and route->view references in extract()"
```

---

## 任务 4：迁移 Flask 和 FastAPI 解析器

**文件：**
- 修改：`src/resolution/frameworks/python.ts`（flaskResolver 和 fastapiResolver 部分）

- [ ] **步骤 1：编写失败测试**

追加到 `__tests__/frameworks.test.ts`：

```typescript
import { flaskResolver, fastapiResolver } from '../src/resolution/frameworks/python';

describe('flaskResolver.extract', () => {
  it('extracts route and reference from @app.route', () => {
    const src = `
@app.route('/users')
def list_users():
    return []
`;
    const { nodes, references } = flaskResolver.extract!('app.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });

  it('extracts blueprint routes', () => {
    const src = `
@users_bp.route('/<id>', methods=['POST'])
def create_user(id):
    pass
`;
    const { nodes, references } = flaskResolver.extract!('routes.py', src);
    expect(nodes[0].name).toBe('POST /<id>');
    expect(references[0].referenceName).toBe('create_user');
  });
});

describe('fastapiResolver.extract', () => {
  it('extracts route and reference from @app.get', () => {
    const src = `
@app.get('/users')
async def list_users():
    return []
`;
    const { nodes, references } = fastapiResolver.extract!('main.py', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });

  it('extracts route from router.post', () => {
    const src = `
@router.post('/items')
def create_item(item: Item):
    pass
`;
    const { nodes, references } = fastapiResolver.extract!('items.py', src);
    expect(nodes[0].name).toBe('POST /items');
    expect(references[0].referenceName).toBe('create_item');
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

运行：`npx vitest run __tests__/frameworks.test.ts -t "flaskResolver|fastapiResolver"`
预期结果：FAIL — 两个解析器的 `extract` 均为 undefined。

- [ ] **步骤 3：重写 flaskResolver 和 fastapiResolver**

将 `src/resolution/frameworks/python.ts` 中的 `flaskResolver` 替换为：

```typescript
export const flaskResolver: FrameworkResolver = {
  name: 'flask',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && /\bflask\b/i.test(requirements)) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && /\bflask\b/i.test(pyproject)) return true;
    for (const file of ['app.py', 'application.py', 'main.py', '__init__.py']) {
      const content = context.readFile(file);
      if (content && content.includes('Flask(__name__)')) return true;
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
    return extractDecoratorRoutes(filePath, content, {
      // Flask: @x.route('/path', methods=[...])
      decoratorRegex: /@(\w+)\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/g,
      defaultMethod: 'GET',
      methodFromGroup: 3,
      pathGroup: 2,
      handlerGroup: 4,
      language: 'python',
    });
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
    return extractDecoratorRoutes(filePath, content, {
      // FastAPI: @x.get('/path')
      decoratorRegex: /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/g,
      defaultMethod: '',
      methodGroup: 2,
      pathGroup: 3,
      // handler follows on next def line; captured via post-scan
      handlerGroup: undefined,
      findHandler: true,
      language: 'python',
    });
  },
};
```

并在 `python.ts` 底部添加以下共享辅助函数：

```typescript
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

function extractDecoratorRoutes(filePath: string, content: string, opts: DecoratorRouteOpts) {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  let match: RegExpExecArray | null;
  while ((match = opts.decoratorRegex.exec(content)) !== null) {
    const routePath = match[opts.pathGroup];
    let method = opts.defaultMethod;
    if (opts.methodGroup && match[opts.methodGroup]) {
      method = match[opts.methodGroup].toUpperCase();
    } else if (opts.methodFromGroup && match[opts.methodFromGroup]) {
      const m = match[opts.methodFromGroup].match(/['"]([A-Z]+)['"]/i);
      if (m) method = m[1].toUpperCase();
    }
    const line = content.slice(0, match.index).split('\n').length;
    const name = method ? `${method} ${routePath}` : routePath;
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
      // Find the next `def <name>` after the decorator
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
```

- [ ] **步骤 4：运行测试，确认通过**

运行：`npx vitest run __tests__/frameworks.test.ts -t "flaskResolver|fastapiResolver"`
预期结果：PASS（4 个测试）。

- [ ] **步骤 5：提交**

```bash
git add src/resolution/frameworks/python.ts __tests__/frameworks.test.ts
git commit -m "feat(flask,fastapi): emit route nodes and route->handler references"
```

---

## 任务 5：迁移 Express 解析器

**文件：**
- 修改：`src/resolution/frameworks/express.ts`（extractNodes 部分，约第 83-117 行）

- [ ] **步骤 1：编写失败测试**

追加到 `__tests__/frameworks.test.ts`：

```typescript
import { expressResolver } from '../src/resolution/frameworks/express';

describe('expressResolver.extract', () => {
  it('extracts route with inline handler reference', () => {
    const src = `app.get('/users', listUsers);\n`;
    const { nodes, references } = expressResolver.extract!('routes.ts', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('listUsers');
  });

  it('extracts route with router.post', () => {
    const src = `router.post('/items', auth, createItem);\n`;
    const { nodes, references } = expressResolver.extract!('items.ts', src);
    expect(nodes[0].name).toBe('POST /items');
    // Multiple handlers: prefer the LAST one (convention: middleware comes first, handler last)
    expect(references[0].referenceName).toBe('createItem');
  });

  it('extracts route with controller method reference', () => {
    const src = `app.get('/x', userController.list);\n`;
    const { nodes, references } = expressResolver.extract!('routes.ts', src);
    expect(references[0].referenceName).toBe('list');
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

运行：`npx vitest run __tests__/frameworks.test.ts -t expressResolver`
预期结果：FAIL。

- [ ] **步骤 3：重写 expressResolver.extract**

将 `src/resolution/frameworks/express.ts` 中 `expressResolver` 上现有的 `extractNodes` 方法替换为：

```typescript
  languages: ['javascript', 'typescript'],

  extract(filePath, content) {
    if (!/\.(m?js|tsx?|cjs)$/.test(filePath)) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    // Capture: (app|router).METHOD('/path', handler-expr)
    const regex = /\b(app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const [, _obj, method, routePath, handlers] = match;
      if (method === 'use' && !routePath.startsWith('/')) continue;
      const line = content.slice(0, match.index).split('\n').length;
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
        language: detectLanguage(filePath),
        updatedAt: now,
      };
      nodes.push(routeNode);
      // Last comma-separated arg is the handler; intermediate args are middleware
      const handlerParts = handlers.split(',').map((s) => s.trim()).filter(Boolean);
      const last = handlerParts[handlerParts.length - 1];
      const handlerName = extractTailIdent(last);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: detectLanguage(filePath),
        });
      }
    }
    return { nodes, references };
  },
```

并在文件顶部附近添加：

```typescript
import type { FrameworkResolver, UnresolvedRef } from '../types';
import type { Node } from '../../types';

function extractTailIdent(expr: string): string | null {
  const cleaned = expr.replace(/\s+/g, '').replace(/\(\)$/, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1] : null;
}
```

删除旧的 `extractNodes` 方法。

- [ ] **步骤 4：运行测试，确认通过**

运行：`npx vitest run __tests__/frameworks.test.ts -t expressResolver`
预期结果：PASS。

- [ ] **步骤 5：提交**

```bash
git add src/resolution/frameworks/express.ts __tests__/frameworks.test.ts
git commit -m "feat(express): emit route nodes and route->handler references"
```

---

## 任务 6：迁移 Laravel、Rails、Spring、Gin（Go）、Axum（Rust）、ASP.NET（C#）、Swift 解析器

**文件：**
- 修改：`src/resolution/frameworks/laravel.ts` / `ruby.ts` / `java.ts` / `go.ts` / `rust.ts` / `csharp.ts` / `swift.ts`

每个框架都遵循与任务 3-5 **相同的模式**：

1. 添加 `languages: [...]` 字段。
2. 将 `extractNodes(filePath, content)` 替换为 `extract(filePath, content): { nodes, references }`。
3. 在 `extract()` 内部，对每个匹配的路由正则：创建一个路由节点（复用现有形状）并为处理器/控制器发出 `UnresolvedRef`（`fromNodeId = routeNode.id`）。
4. 为每个框架在 `__tests__/frameworks.test.ts` 中添加一个单元测试，验证至少一种路由形式能同时产生节点和处理器引用。

**各框架具体说明：**

- **Laravel** (`laravel.ts`)：`Route::get('/x', [Ctrl::class, 'method'])` → 处理器引用名 = `method`；`Route::get('/x', 'Ctrl@method')` → 处理器引用名 = `method`；`Route::resource('users', UserController::class)` → 处理器引用名 = `UserController`。`languages: ['php']`。

- **Rails** (`ruby.ts`)：`get '/x', to: 'users#index'` → 处理器引用名 = `index`（按 `users` 限定范围）；`resources :users` → 每个 CRUD 动作一个节点，各自引用 `UsersController` 上对应的方法名。`languages: ['ruby']`。

- **Spring** (`java.ts`)：方法上的 `@GetMapping("/x")` → 处理器是其后的方法名（向前扫过装饰器）。`languages: ['java']`。

- **Gin / chi / gorilla** (`go.ts`)：`r.GET("/x", handler)` → 处理器引用 = 最后一个参数中的最后一个标识符。`languages: ['go']`。

- **Axum / actix** (`rust.ts`)：`.route("/x", get(handler))` → 处理器引用 = `get(...)` 内的标识符。`languages: ['rust']`。

- **ASP.NET** (`csharp.ts`)：`[HttpGet("/x")] public ActionResult Method()` → 处理器引用 = 同一类上的方法名。`languages: ['csharp']`。

- **Swift / Vapor** (`swift.ts`)：`app.get("/x", use: handler)` → 处理器引用 = `use:` 后的标识符。`languages: ['swift']`。

每个框架各自提交，格式为：

```bash
git add src/resolution/frameworks/<framework>.ts __tests__/frameworks.test.ts
git commit -m "feat(<framework>): emit route nodes and route->handler references"
```

**重要：** 保持每个框架的提交独立，以便在任一框架导致回归时可以单独回滚。

### 任务 6a：Laravel

- [ ] **步骤 1：编写测试** `Route::get('/users', [UserController::class, 'index'])` → `{nodes[0].name='GET /users', references[0].referenceName='index'}`。
- [ ] **步骤 2：运行测试，确认失败。**
- [ ] **步骤 3：实现 `extract()`**，遵循 Express 模式。正则：`/Route::(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g`。通过 `resolveLaravelHandler()` 从第三组中提取处理器：去掉 `[`/`]`/`::class`，取逗号分割数组的第二个元素或 `Ctrl@method`。
- [ ] **步骤 4：运行测试，确认通过。**
- [ ] **步骤 5：提交。**

### 任务 6b：Rails

- [ ] **步骤 1：编写测试** `get '/users', to: 'users#index'` → `{references[0].referenceName='index'}`。
- [ ] **步骤 2：运行测试，确认失败。**
- [ ] **步骤 3：实现 `extract()`**。正则：`/\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]\s*,\s*to:\s*['"]([^'"]+)['"]/g` → `controller#method` 按 `#` 分割，处理器 = `method`。
- [ ] **步骤 4：运行测试，确认通过。**
- [ ] **步骤 5：提交。**

### 任务 6c：Spring

- [ ] **步骤 1：编写测试** `@GetMapping("/x")\npublic String list() {...}` → `{references[0].referenceName='list'}`。
- [ ] **步骤 2：运行测试，确认失败。**
- [ ] **步骤 3：实现 `extract()`**，使用共享的 `extractDecoratorRoutes` 辅助函数（如果更清晰，可将其移至新建的 `src/resolution/frameworks/shared.ts`）。找到每个映射注解后的第一个 `public` 或 `private` 方法声明的名称。
- [ ] **步骤 4：运行测试，确认通过。**
- [ ] **步骤 5：提交。**

### 任务 6d：Go

- [ ] **步骤 1：编写测试** `r.GET("/x", handler)` 和 `router.Handle("/x", handler)` → `{references[0].referenceName='handler'}`。
- [ ] **步骤 2：运行测试，确认失败。**
- [ ] **步骤 3：实现 `extract()`**。正则：`/\b(?:router|r|mux|app)\.(GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc)\s*\(\s*["]([^"]+)["]\s*,\s*([^)]+)\)/g`。处理器 = 第三组中的最后一个标识符。
- [ ] **步骤 4：运行测试，确认通过。**
- [ ] **步骤 5：提交。**

### 任务 6e：Rust

- [ ] **步骤 1：编写测试** `.route("/x", get(list_users))` → `{references[0].referenceName='list_users'}`。
- [ ] **步骤 2：运行测试，确认失败。**
- [ ] **步骤 3：实现 `extract()`**。正则：`/\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\s*\(\s*(\w+)/g` → 处理器 = 第 3 组。
- [ ] **步骤 4：运行测试，确认通过。**
- [ ] **步骤 5：提交。**

### 任务 6f：C#（ASP.NET）

- [ ] **步骤 1：编写测试** `[HttpGet("/x")]\npublic IActionResult List()` → `{references[0].referenceName='List'}`。
- [ ] **步骤 2：运行测试，确认失败。**
- [ ] **步骤 3：实现 `extract()`**。找到属性后，向前扫描到第一个 `public|private|protected` 方法声明并取其名称。
- [ ] **步骤 4：运行测试，确认通过。**
- [ ] **步骤 5：提交。**

### 任务 6g：Swift / Vapor

- [ ] **步骤 1：编写测试** `app.get("/users", use: list)` → `{references[0].referenceName='list'}`。
- [ ] **步骤 2：运行测试，确认失败。**
- [ ] **步骤 3：实现 `extract()`**。正则：`/\b(app|router|routes)\.(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*,\s*use:\s*([A-Za-z_][A-Za-z0-9_.]*)/g` → 处理器 = 第 4 组的最后一个片段。
- [ ] **步骤 4：运行测试，确认通过。**
- [ ] **步骤 5：提交。**

### 任务 6h：React 和 Svelte

这些是 UI 框架，路由映射到组件而非服务端处理器。迁移接口但保留现有行为：

- [ ] **步骤 1：迁移 `reactResolver`**（`src/resolution/frameworks/react.ts`）——添加 `languages: ['javascript', 'typescript']`，将 `extractNodes` 重命名为 `extract`，使其返回 `{ nodes, references: [] }`（现有逻辑只发出节点，暂不需要处理器引用——后续可添加 `<Route element={<Page/>}/>` → `Page` 引用）。
- [ ] **步骤 2：迁移 `svelteResolver`**（`src/resolution/frameworks/svelte.ts`）——同上；`languages: ['svelte']`。
- [ ] **步骤 3：为每个解析器添加冒烟测试**，验证 `extract()` 返回与之前相同的节点形状。
- [ ] **步骤 4：运行测试，确认通过。**
- [ ] **步骤 5：提交。**

---

## 任务 7：将框架提取接线到 `ExtractionOrchestrator`

**文件：**
- 修改：`src/extraction/index.ts`（每文件提取结果合并路径）
- 修改：`src/extraction/parse-worker.ts`（如果提取在 worker 中运行，则将检测到的框架传入 worker）

这是核心接线变更，在每个文件被 tree-sitter 解析后运行。

- [ ] **步骤 1：编写集成测试**

创建 `__tests__/frameworks-integration.test.ts`：

```typescript
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Synapse } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Django end-to-end', () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a route->view edge from urls.py to view class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-'));
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '# marker');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.mkdirSync(path.join(tmpDir, 'users'));
    fs.writeFileSync(path.join(tmpDir, 'users/__init__.py'), '');
    fs.writeFileSync(path.join(tmpDir, 'users/views.py'),
      'class UserListView:\n    def get(self, request): pass\n');
    fs.writeFileSync(path.join(tmpDir, 'users/urls.py'),
      'from django.urls import path\n' +
      'from users.views import UserListView\n' +
      'urlpatterns = [path("users/", UserListView.as_view(), name="user-list")]\n');

    const cg = new Synapse(tmpDir);
    await cg.initialize();
    await cg.indexAll();

    const nodes = cg.queries.searchNodes({ kinds: ['route'] });
    expect(nodes.length).toBeGreaterThan(0);
    const route = nodes.find(n => n.name === 'users/');
    expect(route).toBeDefined();

    const view = cg.queries.getNodesByName('UserListView').find(n => n.kind === 'class');
    expect(view).toBeDefined();

    const edges = cg.queries.getOutgoingEdges(route!.id);
    const toView = edges.find(e => e.target === view!.id);
    expect(toView).toBeDefined();
    expect(toView!.kind).toBe('references');

    await cg.close();
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

运行：`npx vitest run __tests__/frameworks-integration.test.ts`
预期结果：FAIL — 没有路由节点被创建（框架 extract 尚未接线）。

- [ ] **步骤 3：添加接线代码**

在 `src/extraction/index.ts` 中，找到 `extractFromSource` 函数（约第 600 行；对单个文件运行 tree-sitter 并返回 `ExtractionResult` 的函数）。在 tree-sitter 之后添加框架提取作为后处理增强。

找到 `extractFromSource` 末尾构建 `ExtractionResult` 的位置（约第 1000-1015 行）。在 `return result` 之前添加：

```typescript
// Framework-specific extraction (routes, etc.)
if (detectedFrameworks && detectedFrameworks.length > 0) {
  const applicable = getApplicableFrameworks(detectedFrameworks, language);
  for (const fw of applicable) {
    if (!fw.extract) continue;
    try {
      const fwResult = fw.extract(filePath, content);
      result.nodes.push(...fwResult.nodes);
      result.unresolvedReferences.push(...fwResult.references);
    } catch (err) {
      result.errors.push({
        message: `Framework extractor '${fw.name}' failed: ${err instanceof Error ? err.message : String(err)}`,
        filePath,
        severity: 'warning',
      });
    }
  }
}
```

同时将 `detectedFrameworks?: FrameworkResolver[]` 作为参数添加到 `extractFromSource`。

在 `ExtractionOrchestrator.indexAll`（约第 412 行）中，在启动解析 worker 之前，一次性检测框架：

```typescript
// Detect frameworks once per indexing run (project-level signal)
const resolutionContext = buildResolutionContext(this.rootDir, this.queries);
const detectedFrameworks = detectFrameworks(resolutionContext);
```

将 `detectedFrameworks` 传入解析 worker 批次配置（或者，如果 parse worker 不直接调用 `extractFromSource`，则传入对原始文件内容调用框架 extract 的主线程合并步骤）。如果 worker 已经能访问文件内容，则传入框架**名称**，并在 worker 内部通过 `getAllFrameworkResolvers().filter(f => detectedNames.includes(f.name))` 重新解析为解析器对象——含函数的对象无法跨 worker_threads postMessage 边界传递。

- [ ] **步骤 4：运行测试，确认通过**

运行：`npx vitest run __tests__/frameworks-integration.test.ts`
预期结果：PASS。

- [ ] **步骤 5：运行完整测试套件，检查回归**

运行：`npx vitest run`
预期结果：所有现有测试均通过。

- [ ] **步骤 6：提交**

```bash
git add src/extraction/index.ts src/extraction/parse-worker.ts __tests__/frameworks-integration.test.ts
git commit -m "feat(extraction): run framework extractors after tree-sitter parse"
```

---

## 任务 8：删除死代码 + 更新 README

**文件：**
- 修改：`src/resolution/frameworks/*.ts` — 确认没有遗留的 `extractNodes`
- 修改：`README.md` — 添加框架路由提取章节

- [ ] **步骤 1：grep 检查残留引用**

运行：`grep -rn "extractNodes" src/ __tests__/`
预期结果：零匹配。如有残留，删除或重命名。

- [ ] **步骤 2：运行完整构建和测试**

运行：`npm run build && npm test`
预期结果：构建成功；所有测试通过。

- [ ] **步骤 3：添加 README 章节**

在 `README.md` 特性列表后追加：

```markdown
### Framework-aware Routes

Synapse recognizes web framework routing files and links URL patterns to their handlers:

- **Django**: `urlpatterns` entries in `urls.py` — `path()`, `re_path()`, `url()`, `include()`
- **Flask / FastAPI**: `@app.route` / `@app.get` / `@router.post` decorators
- **Express**: `app.get(...)`, `router.post(...)`
- **Laravel**: `Route::get()`, `Route::resource()`
- **Rails**: `resources :users`, `get 'x', to: 'y#z'`
- **Spring**: `@GetMapping`, `@RequestMapping`
- **Gin / chi / gorilla**: `r.GET(...)`
- **Axum / actix**: `.route("/x", get(handler))`
- **ASP.NET**: `[HttpGet]` + action method
- **Vapor**: `app.get("x", use: handler)`

Query `synapse_callers(YourView)` and the route pattern will appear as an incoming edge.
```

- [ ] **步骤 4：提交**

```bash
git add README.md
git commit -m "docs: document framework route extraction"
```

---

## 任务 9：开 PR

- [ ] **步骤 1：推送分支到 fork**

```bash
git push -u origin feat/framework-extract-wiring
```

- [ ] **步骤 2：创建 PR**

```bash
gh pr create \
  --repo colbymchenry/synapse \
  --base main \
  --head timomeara:feat/framework-extract-wiring \
  --title "feat: wire up framework route extraction" \
  --body "$(cat <<'EOF'
## Problem

`FrameworkResolver.extractNodes` is declared in the type but never called anywhere in `src/`. As a result, the graph has zero `route` nodes for any framework, and the URL-to-handler link (e.g. Django `urls.py` entry -> view class) doesn't exist. This makes `synapse_callers(MyView)` silently miss its most important caller.

## Fix

- Replaces the dead `extractNodes?(filePath, content): Node[]` hook with `extract?(filePath, content): { nodes, references }`.
- Calls `extract()` inside the extraction pipeline for every framework whose declared `languages` include the current file's language.
- Updates all 13 existing framework resolvers (Django, Flask, FastAPI, Express, Laravel, Rails, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit) to emit both route nodes AND handler references. The references flow through the existing resolution pipeline (name matching, import resolution, framework-specific `resolve()`) to produce `route -> handler` edges.

## Tests

- Unit tests per framework in `__tests__/frameworks.test.ts`.
- End-to-end Django test in `__tests__/frameworks-integration.test.ts` that verifies a real `urls.py -> views.py` edge.

## Stats

| Category | Lines |
|----------|------:|
| Production code | ~X |
| Tests | ~Y |
| Docs | ~Z |
EOF
)"
```

- [ ] **步骤 3：在任务追踪器中链接 PR**（如果有的话）。

---

## 自查清单

- [ ] **规范覆盖：** 原始代码库中每个框架都有迁移任务。Django 的测试覆盖最丰富，因为它是本次改动的动机案例。
- [ ] **无占位符：** 每个任务都展示了实际代码。任务 6 中"与任务 X 相同的模式"措辞以任务 3-5 的完整实现为参照。
- [ ] **类型一致性：** `FrameworkExtractionResult` 在任务 1 中定义一次，每个解析器的 `extract` 签名均使用该类型。
- [ ] **统计占位符**（X/Y/Z）在 PR 创建时填入，而非计划阶段填入。

## 已知缺口（刻意不在范围内）

- **基于 AST 的提取。** 正则对常见形式已足够。后续 PR 可换用 tree-sitter AST。
- **DRF router 展开。** `router.register(r'users', UserViewSet)` 产生一个指向 viewset 的路由节点。展开为 6 个 CRUD 动作节点可作为后续 PR。
- **React Router 处理器边。** `<Route element={<Page/>}/>` 目前仅产生路由节点。后续可添加 `route -> Page` 引用。
- **Spring Controller 类级作用域。** 方法级映射已支持；类级 `@RequestMapping` 基路径组合作为后续 PR。
