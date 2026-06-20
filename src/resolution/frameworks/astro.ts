/**
 * Astro 框架解析器
 *
 * 处理 Astro 组件引用、`Astro` 全局对象、`astro:*` 虚拟
 * 模块导入，以及 Astro `src/pages/` 基于文件的路由。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

/**
 * Astro 虚拟模块前缀——由框架提供，非用户代码
 */
const ASTRO_VIRTUAL_MODULES = [
  'astro:content',
  'astro:assets',
  'astro:actions',
  'astro:env',
  'astro:i18n',
  'astro:middleware',
  'astro:transitions',
  'astro:components',
  'astro:schema',
];

export const astroResolver: FrameworkResolver = {
  name: 'astro',

  detect(context: ResolutionContext): boolean {
    // 检查 package.json 中是否有 astro
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.astro) {
          return true;
        }
      } catch {
        // 无效的 JSON
      }
    }

    // 检查项目中是否有 .astro 文件
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.astro'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：`Astro` 全局对象（Astro.props、Astro.url、Astro.params 等）
    // ——在每个组件的 frontmatter 中由运行时提供。将其解析为
    // 框架提供，以避免与用户定义的名为 Astro 的符号匹配。
    if (ref.referenceName === 'Astro' || ref.referenceName.startsWith('Astro.')) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // 模式 2：astro:* 虚拟模块导入（astro:content、astro:assets 等）
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('astro:')) {
      if (ASTRO_VIRTUAL_MODULES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        return {
          original: ref,
          targetNodeId: ref.fromNodeId,
          confidence: 1.0,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：组件引用（PascalCase）——解析为组件节点。
    // 模板标签以 `references` 到达，frontmatter 表达式用法以 `calls` 到达。
    if (
      isPascalCase(ref.referenceName) &&
      (ref.referenceKind === 'references' || ref.referenceKind === 'calls')
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

    return null;
  },

  extract(filePath: string, _content: string) {
    const nodes: Node[] = [];
    const now = Date.now();

    // 规范化为正斜杠
    const normalized = filePath.replace(/\\/g, '/');

    // Astro 基于文件的路由位于 src/pages/ 下——.astro 文件是页面，
    // .ts/.js 文件是 API 端点。（.md/.mdx 页面也存在但不作为源代码索引。）
    // 以下划线开头的路径段被 Astro 排除在路由之外。
    const pagesMatch = /(?:^|\/)src\/pages\//.exec(normalized);
    if (pagesMatch && /\.(astro|ts|js|mjs)$/.test(normalized)) {
      const afterPages = normalized.substring(pagesMatch.index + pagesMatch[0].length);
      const base = afterPages.split('/').pop() || '';

      // 以下划线开头的路径段被 Astro 排除在路由之外；
      // pages 目录中出现的 `*.config.*` 文件也不是路由。
      if (
        !afterPages.split('/').some((segment) => segment.startsWith('_')) &&
        !/\.config\.[a-z]+$/.test(base)
      ) {
        const routePath = filePathToAstroRoute(afterPages);

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
          language: normalized.endsWith('.astro') ? 'astro' : 'typescript',
          updatedAt: now,
        });
      }
    }

    return { nodes, references: [] };
  },
};

/**
 * 检查字符串是否为 PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * 通过名称查找解析 Astro 组件引用
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
 * 将 src/pages/ 下的路径转换为 Astro 路由路径。
 *
 * blog/[slug].astro        -> /blog/:slug
 * blog/[...path].astro     -> /blog/*path
 * api/posts.ts             -> /api/posts
 * index.astro              -> /
 */
function filePathToAstroRoute(afterPages: string): string {
  // 去除扩展名
  const withoutExt = afterPages.replace(/\.(astro|ts|js|mjs)$/, '');

  // index 文件映射到父路径（index -> /，blog/index -> /blog）
  const withoutIndex = withoutExt.replace(/(^|\/)index$/, '$1').replace(/\/$/, '');

  // 转换 Astro 参数语法
  const route = '/' + withoutIndex
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1') // [...rest] -> *rest（捕获全部）
    .replace(/\[([^\]]+)\]/g, ':$1'); // [param] -> :param

  if (route === '/') return '/';
  // 去除末尾斜杠
  return route.replace(/\/$/, '');
}
