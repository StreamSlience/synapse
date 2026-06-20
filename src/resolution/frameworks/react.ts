/**
 * React 框架解析器
 *
 * 处理 React 和 Next.js 模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const reactResolver: FrameworkResolver = {
  name: 'react',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    // 检查 package.json 中是否包含 React
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react || deps.next || deps['react-native']) {
          return true;
        }
      } catch {
        // JSON 格式无效
      }
    }

    // 检查是否存在 .jsx/.tsx 文件
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1：组件引用（PascalCase）。仅来自支持 JSX 的文件——组件在标记中
    // 被使用，而标记只在 .tsx/.jsx 中解析。若无此限制，普通 .ts 文件中每个
    // PascalCase 类型引用都会走组件解析：在同名类按包分布的 monorepo（#764，
    // amplication）中，一个 `.ts` GraphQL 类型文件自身的 `Account` 类型别名
    // 会输给另一个包中任意一个 `Account` 类（框架的 0.8 优先级高于名称匹配器
    // 的邻近正确 0.7）。
    if (
      (ref.language === 'tsx' || ref.language === 'jsx') &&
      isPascalCase(ref.referenceName) &&
      !isBuiltInType(ref.referenceName)
    ) {
      const result = resolveComponent(ref.referenceName, ref.filePath, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2：Hook 引用（use*）
    if (ref.referenceName.startsWith('use') && ref.referenceName.length > 3) {
      const result = resolveHook(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3：Context 引用
    if (ref.referenceName.endsWith('Context') || ref.referenceName.endsWith('Provider')) {
      const result = resolveContext(ref.referenceName, context);
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
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // 提取组件定义
    // function Component() 或 const Component = () =>
    const componentPatterns = [
      // 函数式组件
      /(?:export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g,
      // 箭头函数组件
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_]*)\s*=>/g,
      // forwardRef 组件
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?forwardRef/g,
      // memo 组件
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?memo/g,
    ];

    for (const pattern of componentPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [fullMatch, name] = match;
        const line = content.slice(0, match.index).split('\n').length;

        // 检查是否返回 JSX（粗略启发式）
        const afterMatch = content.slice(match.index + fullMatch.length, match.index + fullMatch.length + 500);
        const hasJSX = afterMatch.includes('<') && (afterMatch.includes('/>') || afterMatch.includes('</'));

        if (hasJSX) {
          nodes.push({
            id: `component:${filePath}:${name}:${line}`,
            kind: 'component',
            name: name!,
            qualifiedName: `${filePath}::${name}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: fullMatch.length,
            language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
            isExported: fullMatch.includes('export'),
            updatedAt: now,
          });
        }
      }
    }

    // 提取自定义 Hook
    const hookPattern = /(?:export\s+)?(?:function|const|let)\s+(use[A-Z][a-zA-Z0-9]*)\s*[=(]/g;
    let hookMatch;
    while ((hookMatch = hookPattern.exec(content)) !== null) {
      const [fullMatch, name] = hookMatch;
      const line = content.slice(0, hookMatch.index).split('\n').length;

      nodes.push({
        id: `hook:${filePath}:${name}:${line}`,
        kind: 'function',
        name: name!,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: fullMatch.length,
        language: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript',
        isExported: fullMatch.includes('export'),
        updatedAt: now,
      });
    }

    // React Router：<Route path="/x" component={Comp}/> (v5) 或
    // <Route path="/x" element={<Comp/>}/> (v6)。属性可以任意顺序出现，
    // 且 element={...} 包含嵌套的 `>`，因此对每个 <Route 后的窗口进行扫描，
    // 而不是尝试匹配完整（可能跨行）的标签。
    const routeTagRegex = /<Route\b/g;
    let routeMatch: RegExpExecArray | null;
    while ((routeMatch = routeTagRegex.exec(content)) !== null) {
      const window = content.slice(routeMatch.index, routeMatch.index + 400);
      const pathMatch = window.match(/\bpath\s*=\s*["']([^"']+)["']/);
      if (!pathMatch) continue; // index/layout routes without a path
      const routePath = pathMatch[1]!;
      const compMatch =
        window.match(/\bcomponent\s*=\s*\{\s*([A-Z][A-Za-z0-9_]*)/) ||
        window.match(/\belement\s*=\s*\{\s*<\s*([A-Z][A-Za-z0-9_]*)/);
      const line = content.slice(0, routeMatch.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${routePath}`,
        kind: 'route',
        name: routePath,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
        updatedAt: now,
      };
      nodes.push(routeNode);
      if (compMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: compMatch[1]!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
        });
      }
    }

    // React Router data-router（v6.4+）：createBrowserRouter([{ path, element }])。
    // 仅扫描使用 data-router API 的文件，然后提取每个路由对象的
    // `path` + `element={<Comp/>}` / `Component: Comp`（前向窗口确认
    // 这是路由对象而非普通的 `path:` 字段）。
    if (/\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements)\b/.test(content)) {
      const objPathRe = /\bpath\s*:\s*['"]([^'"]*)['"]/g;
      let om: RegExpExecArray | null;
      while ((om = objPathRe.exec(content)) !== null) {
        const win = content.slice(om.index, om.index + 300);
        const compMatch =
          win.match(/\belement\s*:\s*<\s*([A-Z][A-Za-z0-9_]*)/) ||
          win.match(/\bComponent\s*:\s*([A-Z][A-Za-z0-9_]*)/);
        if (!compMatch) continue; // require a component → it's a real route object
        const routePath = om[1] || '/';
        const line = content.slice(0, om.index).split('\n').length;
        const routeNode: Node = {
          id: `route:${filePath}:${line}:${routePath}`,
          kind: 'route',
          name: routePath,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: 0,
          language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
          updatedAt: now,
        };
        nodes.push(routeNode);
        references.push({
          fromNodeId: routeNode.id,
          referenceName: compMatch[1]!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
        });
      }
    }

    // 提取 Next.js 页面/路由（pages 目录约定）
    if (filePath.includes('pages/') || filePath.includes('app/')) {
      // pages 中的默认导出即为路由
      if (content.includes('export default')) {
        const routePath = filePathToRoute(filePath);
        if (routePath) {
          const line = content.indexOf('export default');
          const lineNum = content.slice(0, line).split('\n').length;

          nodes.push({
            id: `route:${filePath}:${routePath}:${lineNum}`,
            kind: 'route',
            name: routePath,
            qualifiedName: `${filePath}::route:${routePath}`,
            filePath,
            startLine: lineNum,
            endLine: lineNum,
            startColumn: 0,
            endColumn: 0,
            language: filePath.endsWith('.tsx') ? 'tsx' : filePath.endsWith('.ts') ? 'typescript' : 'javascript',
            updatedAt: now,
          });
        }
      }
    }

    return { nodes, references };
  },
};

/**
 * 检查字符串是否为 PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * 检查名称是否为内置类型
 */
function isBuiltInType(name: string): boolean {
  return BUILT_IN_TYPES.has(name);
}

const BUILT_IN_TYPES = new Set([
  'Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Math', 'Number',
  'Object', 'Promise', 'RegExp', 'String', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'React', 'Component', 'Fragment', 'Suspense', 'StrictMode',
]);

const COMPONENT_KINDS = new Set(['component', 'function', 'class']);

/**
 * 使用基于名称的查找解析组件引用
 */
function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const components = candidates.filter((n) => COMPONENT_KINDS.has(n.kind));
  if (components.length === 0) return null;

  // 优先选择同目录下的候选
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = components.filter((n) => n.filePath.startsWith(fromDir));
  if (sameDir.length > 0) return sameDir[0]!.id;

  // 优先选择组件目录下的候选
  const COMPONENT_DIRS = ['/components/', '/src/components/', '/app/components/', '/pages/', '/src/pages/', '/views/', '/src/views/'];
  const preferred = components.filter((n) =>
    COMPONENT_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  // 无位置信号：仅允许解析无歧义的名称。此处返回 components[0]
  // 会在整个仓库中选取任意同名类（#764）——交由名称匹配器的邻近性评分来决定。
  return components.length === 1 ? components[0]!.id : null;
}

/**
 * 使用基于名称的查找解析自定义 Hook 引用
 */
function resolveHook(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const hooks = candidates.filter((n) => n.kind === 'function' && n.name.startsWith('use'));
  if (hooks.length === 0) return null;

  // 优先选择 hooks 目录下的候选
  const HOOK_DIRS = ['/hooks/', '/src/hooks/', '/lib/hooks/', '/utils/hooks/'];
  const preferred = hooks.filter((n) =>
    HOOK_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return hooks[0]!.id;
}

/**
 * 使用基于名称的查找解析 Context 引用
 */
function resolveContext(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) {
    // 尝试去掉 Context/Provider 后缀再查找
    const baseName = name.replace(/Context$|Provider$/, '');
    if (baseName !== name) {
      const baseCandidates = context.getNodesByName(baseName);
      if (baseCandidates.length > 0) return baseCandidates[0]!.id;
    }
    return null;
  }

  // 优先选择 context 目录下的候选
  const CONTEXT_DIRS = ['/context/', '/contexts/', '/src/context/', '/src/contexts/', '/providers/', '/src/providers/'];
  const preferred = candidates.filter((n) =>
    CONTEXT_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return candidates[0]!.id;
}

/**
 * 将文件路径转换为 Next.js 路由
 */
function filePathToRoute(filePath: string): string | null {
  // pages/index.tsx -> /
  // pages/about.tsx -> /about
  // pages/blog/[slug].tsx -> /blog/:slug
  // app/page.tsx -> /
  // app/about/page.tsx -> /about

  // 只有真正的页面组件文件才是路由。排除非页面扩展名
  // (.mjs/.json/.cjs)、配置文件（next.config.ts、vite.config.ts……）以及
  // Next.js 特殊文件（_app/_document）。这也防止了 `nextjs-pages/` 目录下
  // 带 `export default` 的 `*.config.mjs` 被误认为"路由"。
  const base = filePath.split('/').pop() ?? '';
  if (!/\.(tsx?|jsx?)$/.test(base)) return null;
  if (base.startsWith('_') || /\.config\.[a-z]+$/.test(base)) return null;

  // 将 pages/ 和 app/ 作为路径片段匹配（而非子串——`nextjs-pages/`
  // 不应被视为 `pages/` 路由目录）。
  if (/(?:^|\/)pages\//.test(filePath)) {
    let route = filePath
      .replace(/^.*pages\//, '/')
      .replace(/\/index\.(tsx?|jsx?)$/, '')
      .replace(/\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  if (/(?:^|\/)app\//.test(filePath)) {
    // App router - 只有 page.tsx 文件才是路由
    if (!filePath.includes('page.')) {
      return null;
    }

    let route = filePath
      .replace(/^.*app\//, '/')
      .replace(/\/page\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  return null;
}
