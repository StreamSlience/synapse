/**
 * Vue / Nuxt 框架解析器
 *
 * 处理 Vue 组件引用、编译器宏（defineProps 等）、
 * Nuxt 自动导入，以及 Nuxt 基于文件的路由模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

/**
 * Vue 3 编译器宏——由编译器提供，非用户代码
 */
const VUE_COMPILER_MACROS = new Set([
  'defineProps',
  'defineEmits',
  'defineExpose',
  'defineOptions',
  'defineSlots',
  'defineModel',
  'withDefaults',
]);

/**
 * Nuxt 自动导入的组合式函数和工具
 */
const NUXT_AUTO_IMPORTS = new Set([
  // 路由
  'useRoute',
  'useRouter',
  'navigateTo',
  'abortNavigation',
  // 数据获取
  'useFetch',
  'useAsyncData',
  'useLazyFetch',
  'useLazyAsyncData',
  'refreshNuxtData',
  // 状态
  'useState',
  'clearNuxtState',
  // Head
  'useHead',
  'useSeoMeta',
  'useServerSeoMeta',
  // 运行时
  'useRuntimeConfig',
  'useAppConfig',
  'useNuxtApp',
  // Cookie
  'useCookie',
  // 错误
  'useError',
  'createError',
  'showError',
  'clearError',
  // 页面/布局
  'definePageMeta',
  'defineNuxtConfig',
  'defineNuxtPlugin',
  'defineNuxtRouteMiddleware',
  // 请求
  'useRequestHeaders',
  'useRequestEvent',
  'useRequestFetch',
  'useRequestURL',
]);

/**
 * Nuxt 虚拟模块前缀（自动导入命名空间）
 */
const NUXT_VIRTUAL_MODULES = [
  '#imports',
  '#components',
  '#app',
  '#build',
  '#head',
];

export const vueResolver: FrameworkResolver = {
  name: 'vue',

  detect(context: ResolutionContext): boolean {
    // 检查 package.json 中是否有 vue 或 nuxt
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.vue || deps.nuxt || deps['@nuxt/kit']) {
          return true;
        }
      } catch {
        // 无效的 JSON
      }
    }

    // 检查项目中是否有 .vue 文件
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.vue'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：Vue 编译器宏（defineProps、defineEmits 等）
    if (VUE_COMPILER_MACROS.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // 模式 2：Nuxt 自动导入的组合式函数
    if (NUXT_AUTO_IMPORTS.has(ref.referenceName)) {
      return {
        original: ref,
        targetNodeId: ref.fromNodeId,
        confidence: 1.0,
        resolvedBy: 'framework',
      };
    }

    // 模式 3：Nuxt 虚拟模块导入（#imports、#components 等）
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('#')) {
      if (NUXT_VIRTUAL_MODULES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        return {
          original: ref,
          targetNodeId: ref.fromNodeId,
          confidence: 1.0,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 4：@ 别名导入（@/components/Foo -> src/components/Foo）
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('@/')) {
      const aliasPath = ref.referenceName.replace('@/', 'src/');
      for (const ext of ['', '.ts', '.js', '.vue', '/index.ts', '/index.js', '/index.vue']) {
        const fullPath = aliasPath + ext;
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

    // 模式 5：~ 别名导入（~/components/Foo -> src/components/Foo，Nuxt 约定）
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('~/')) {
      const aliasPath = ref.referenceName.replace('~/', 'src/');
      for (const ext of ['', '.ts', '.js', '.vue', '/index.ts', '/index.js', '/index.vue']) {
        const fullPath = aliasPath + ext;
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

    // 模式 6：组件引用（PascalCase）——解析到 .vue 文件
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

  extract(filePath: string, _content: string) {
    const nodes: Node[] = [];
    const now = Date.now();

    // 规范化为正斜杠
    const normalized = filePath.replace(/\\/g, '/');

    // 检测 Nuxt 页面路由（pages/ 目录）
    const pagesIndex = normalized.indexOf('/pages/');
    if (pagesIndex !== -1 && normalized.endsWith('.vue')) {
      const routePath = filePathToNuxtRoute(normalized, pagesIndex + '/pages/'.length);
      if (routePath !== null) {
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
          language: 'vue',
          updatedAt: now,
        });
      }
    }

    // 检测 Nuxt API 路由（server/api/ 目录）
    const apiIndex = normalized.indexOf('/server/api/');
    if (apiIndex !== -1) {
      const afterApi = normalized.substring(apiIndex + '/server/api/'.length);
      const routeName = afterApi
        .replace(/\.[^/.]+$/, '') // 去除扩展名
        .replace(/\/index$/, ''); // index -> 父路径
      const apiRoute = '/api/' + routeName;

      nodes.push({
        id: `route:${filePath}:${apiRoute}:1`,
        kind: 'route',
        name: apiRoute,
        qualifiedName: `${filePath}::route:${apiRoute}`,
        filePath,
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        language: normalized.endsWith('.vue') ? 'vue' : 'typescript',
        updatedAt: now,
      });
    }

    // 检测 Nuxt 中间件（middleware/ 目录）
    const middlewareIndex = normalized.indexOf('/middleware/');
    if (middlewareIndex !== -1) {
      const afterMiddleware = normalized.substring(middlewareIndex + '/middleware/'.length);
      const middlewareName = afterMiddleware.replace(/\.[^/.]+$/, '');

      nodes.push({
        id: `middleware:${filePath}:${middlewareName}:1`,
        kind: 'function',
        name: middlewareName,
        qualifiedName: `${filePath}::middleware:${middlewareName}`,
        filePath,
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        language: normalized.endsWith('.vue') ? 'vue' : 'typescript',
        updatedAt: now,
      });
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
 * 将 Vue 组件引用解析到其 .vue 文件
 */
function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  // 先收集所有文件名匹配项。之前的版本会返回树中找到的
  // 第一个 `Button.vue`（同目录通过在下方不可达），因此在多应用
  // monorepo 中，每个应用各有一个 `Button.vue` 时会随机解析（#764）。
  const matches: string[] = [];
  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.vue')) continue;
    const fileName = file.split(/[/\\]/).pop() || '';
    if (fileName.replace(/\.vue$/, '') === name) matches.push(file);
  }
  if (matches.length === 0) return null;

  const componentIn = (file: string): string | null => {
    const nodes = context.getNodesInFile(file);
    const component = nodes.find((n) => n.kind === 'component' && n.name === name);
    return component ? component.id : null;
  };

  // 优先同目录以提高精确度
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = matches.filter((f) => f.startsWith(fromDir));
  if (sameDir.length > 0) return componentIn(sameDir[0]!);

  // 无位置信号：只有文件名无歧义时才解析；
  // 有歧义时交由名称匹配器的邻近度评分决定。
  return matches.length === 1 ? componentIn(matches[0]!) : null;
}

/**
 * 将文件路径转换为 Nuxt 路由路径
 */
function filePathToNuxtRoute(normalized: string, afterPagesStart: number): string | null {
  const afterPages = normalized.substring(afterPagesStart);

  // 去除 .vue 扩展名
  const withoutExt = afterPages.replace(/\.vue$/, '');

  // 去除 /index 后缀（index.vue -> 父路由）
  const withoutIndex = withoutExt.replace(/\/index$/, '');

  // 转换 Nuxt 参数语法 [param] 为 :param
  let route = '/' + withoutIndex
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')  // [...slug] -> *slug（捕获全部）
    .replace(/\[{2}([^\]]+)\]{2}/g, ':$1?') // [[optional]] -> :optional?
    .replace(/\[([^\]]+)\]/g, ':$1');        // [param] -> :param

  if (route === '/') return '/';
  // 去除末尾斜杠
  return route.replace(/\/$/, '');
}
