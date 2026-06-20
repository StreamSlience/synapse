/**
 * Svelte / SvelteKit 框架解析器
 *
 * 处理 Svelte 组件引用、Svelte 5 runes、
 * store 自动订阅，以及 SvelteKit 路由/模块模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

/**
 * Svelte 5 runes——由编译器提供，非用户代码
 */
const SVELTE_RUNES = new Set([
  '$state',
  '$state.raw',
  '$state.snapshot',
  '$derived',
  '$derived.by',
  '$effect',
  '$effect.pre',
  '$effect.root',
  '$effect.tracking',
  '$props',
  '$bindable',
  '$inspect',
  '$host',
]);

/**
 * SvelteKit 框架提供的模块前缀
 */
const SVELTEKIT_MODULE_PREFIXES = [
  '$app/navigation',
  '$app/stores',
  '$app/environment',
  '$app/forms',
  '$app/paths',
  '$env/static/private',
  '$env/static/public',
  '$env/dynamic/private',
  '$env/dynamic/public',
];

export const svelteResolver: FrameworkResolver = {
  name: 'svelte',
  languages: ['svelte'],

  detect(context: ResolutionContext): boolean {
    // 检查 package.json 中是否有 svelte 或 @sveltejs/kit
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.svelte || deps['@sveltejs/kit']) {
          return true;
        }
      } catch {
        // 无效的 JSON
      }
    }

    // 检查项目中是否有 .svelte 文件
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.svelte'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：Svelte runes（$state、$derived、$effect 等）
    if (isRuneReference(ref.referenceName)) {
      // Runes 由编译器提供——返回高可信度的"框架"解析，
      // 避免 Synapse 浪费时间搜索用户定义的符号。
      // 由于 runes 没有真实目标，使用 fromNodeId 作为 targetNodeId。
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // 模式 2：Store 自动订阅（$storeName）
    if (ref.referenceName.startsWith('$') && !ref.referenceName.startsWith('$$')) {
      const storeName = ref.referenceName.substring(1);
      const storeNode = context.getNodesByName(storeName).find(
        (n) => n.kind === 'variable' || n.kind === 'constant'
      );
      if (storeNode) {
        return {
          original: ref,
          targetNodeId: storeNode.id,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：SvelteKit 模块导入（$app/*、$env/*、$lib/*）
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('$')) {
      // $lib/* 解析到 src/lib/*——尝试找到目标文件
      if (ref.referenceName.startsWith('$lib/')) {
        const libPath = ref.referenceName.replace('$lib/', 'src/lib/');
        // 尝试常见扩展名
        for (const ext of ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js']) {
          const fullPath = libPath + ext;
          if (context.fileExists(fullPath)) {
            const nodes = context.getNodesInFile(fullPath);
            if (nodes.length > 0) {
              return {
                original: ref,
                targetNodeId: nodes[0]!.id,
                confidence: 0.9,
                resolvedBy: 'framework',
              };
            }
          }
        }
      }

      // $app/* 和 $env/* 由框架提供
      if (SVELTEKIT_MODULE_PREFIXES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        return {
          original: ref,
          targetNodeId: ref.fromNodeId,
          confidence: 1.0,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 4：组件引用（PascalCase）——解析到 .svelte 文件
    if (isPascalCase(ref.referenceName) && ref.referenceKind === 'calls') {
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

    return null;
  },

  extract(filePath, _content) {
    const nodes: Node[] = [];
    const now = Date.now();

    // 检测 SvelteKit 路由文件
    const fileName = filePath.split(/[/\\]/).pop() || '';
    const routeMatch = getSvelteKitRouteInfo(fileName);

    if (routeMatch) {
      // 从目录结构中提取路由路径
      // 例如：src/routes/blog/[slug]/+page.svelte -> /blog/:slug
      const routePath = filePathToSvelteKitRoute(filePath);

      if (routePath) {
        nodes.push({
          id: `route:${filePath}:${routePath}:1`,
          kind: 'route',
          name: routePath,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          language: filePath.endsWith('.svelte') ? 'svelte' : 'typescript',
          updatedAt: now,
        });
      }
    }

    return { nodes, references: [] };
  },
};

/**
 * 检查引用名称是否为 Svelte rune
 */
function isRuneReference(name: string): boolean {
  // 直接匹配（如 $state、$derived）
  if (SVELTE_RUNES.has(name)) return true;

  // Rune 方法调用以基础 rune 名称传入
  // 例如 $state.raw -> 调用的是"$state"，".raw"作为属性访问
  // 检查是否为具有子方法的基础 rune
  if (name === '$state' || name === '$derived' || name === '$effect') return true;

  return false;
}

/**
 * 检查字符串是否为 PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * 通过名称查找解析 Svelte 组件引用
 */
function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  // 按名称查找组件节点
  const candidates = context.getNodesByName(name);
  const components = candidates.filter((n) => n.kind === 'component');

  if (components.length === 0) return null;

  // 优先同目录
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = components.filter((n) => n.filePath.startsWith(fromDir));
  if (sameDir.length > 0) return sameDir[0]!.id;

  // 无位置信号：只有名称无歧义时才解析——
  // 在多应用 monorepo 中选择 components[0] 会随机命中同名组件（#764）。
  // 有歧义时交由名称匹配器的邻近度评分决定。
  return components.length === 1 ? components[0]!.id : null;
}

/**
 * SvelteKit 路由文件模式
 */
const SVELTEKIT_ROUTE_FILES: Record<string, string> = {
  '+page.svelte': 'page',
  '+page.ts': 'page-load',
  '+page.js': 'page-load',
  '+page.server.ts': 'page-server-load',
  '+page.server.js': 'page-server-load',
  '+layout.svelte': 'layout',
  '+layout.ts': 'layout-load',
  '+layout.js': 'layout-load',
  '+layout.server.ts': 'layout-server-load',
  '+layout.server.js': 'layout-server-load',
  '+server.ts': 'api-endpoint',
  '+server.js': 'api-endpoint',
  '+error.svelte': 'error-page',
};

/**
 * 检查文件名是否为 SvelteKit 路由文件
 */
function getSvelteKitRouteInfo(fileName: string): string | null {
  return SVELTEKIT_ROUTE_FILES[fileName] || null;
}

/**
 * 将文件路径转换为 SvelteKit 路由路径
 */
function filePathToSvelteKitRoute(filePath: string): string | null {
  // 规范化为正斜杠
  const normalized = filePath.replace(/\\/g, '/');

  // 找到 routes 目录
  const routesIndex = normalized.indexOf('/routes/');
  if (routesIndex === -1) return null;

  // 提取 routes/ 之后的路径
  const afterRoutes = normalized.substring(routesIndex + '/routes/'.length);

  // 去除文件名
  const lastSlash = afterRoutes.lastIndexOf('/');
  const dirPath = lastSlash === -1 ? '' : afterRoutes.substring(0, lastSlash);

  // 转换 SvelteKit 参数语法 [param] 为 :param
  let route = '/' + dirPath
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')  // [...rest] -> *rest
    .replace(/\[{2}([^\]]+)\]{2}/g, ':$1?') // [[optional]] -> :optional?
    .replace(/\[([^\]]+)\]/g, ':$1');        // [param] -> :param

  if (route === '/') return '/';
  // 去除末尾斜杠
  return route.replace(/\/$/, '');
}
