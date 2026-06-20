/**
 * Drupal 框架解析器
 *
 * 支持 Drupal 8/9/10/11（基于 Composer 的项目）。不支持 Drupal 7。
 *
 * ## 此解析器的功能
 *
 * 1. **检测** — 读取 composer.json，检查 `require` 或 `require-dev` 中是否存在任何 `drupal/*` 依赖。
 *
 * 2. **路由提取** — 解析 `*.routing.yml` 文件，为每条 Drupal 路由生成 `route` 节点，
 *    并生成指向 `_controller`、`_form` 或实体处理器类/方法的 `references` 边。
 *
 * 3. **Hook 检测** — 扫描 `.module`、`.install`、`.theme` 和 `.inc` 文件中的 Drupal
 *    hook 实现。使用两种策略：
 *      a. 文档块：`@Implements hook_X()` → 精确，无假阳性。
 *      b. 名称模式：函数名为 `{moduleName}_{hookSuffix}()` → 可捕获无文档块的 hook，
 *         但对辅助函数可能产生假阳性。
 *    检测到的 hook 会从实现函数节点向规范 `hook_X` 名称生成 `UnresolvedRef`，
 *    在调用 `synapse_callers` 时将实现链接到 hook。
 *
 * ## 设计决策（供未来迭代审阅）
 *
 * - Hook 图谱解析（v1）：hook 引用作为指向规范 `hook_X` 名称的 UnresolvedRef 存储。
 *   若 Drupal 核心已建立索引，这些引用将解析到核心 hook 定义。否则保持未解析，
 *   但仍可通过 `synapse_search("form_alter")` 搜索到。为每个 hook 创建完整 hook
 *   节点（虚拟节点）的工作推迟到未来迭代。
 *
 * - Services / 插件（v1 范围外）：`*.services.yml` 服务定义和插件注解
 *   （`@Block`、`@FormElement` 等）不予提取。准备实现时在下方添加 TODO。
 *
 * - Twig 模板（v1 范围外）：`.twig` 文件作为文件节点跟踪，但不进行符号提取
 *   （无 tree-sitter Twig 语法）。待 Twig 语法 WASM 可用时实现。
 *
 * ## 未来迭代的 TODO
 *
 * - TODO：从 `*.services.yml` 文件提取服务定义（类 → 服务 ID 边）。
 * - TODO：从 PHP 文档块中提取插件注解（`@Block`、`@FormElement`、`@Field` 等），
 *   并为被注解的类生成插件节点和引用。
 * - TODO：待 tree-sitter Twig 语法可用时添加 Twig 符号提取。
 * - TODO：改进 hook 解析：创建虚拟 `hook_*` 节点，使 `synapse_callers` 在
 *   Drupal 核心未建立索引时也能返回所有实现。
 */

import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 从 `\Drupal\mymodule\Controller\Foo` 之类的 FQCN 中解析最后一个 PHP 命名空间段。
 * 对于不像 FQCN 的字符串返回 `null`。
 */
function lastSegment(fqcn: string): string | null {
  const clean = fqcn.replace(/^\\+/, '').trim();
  if (!clean.includes('\\')) return null;
  const parts = clean.split('\\');
  return parts[parts.length - 1] ?? null;
}

/**
 * 从文件路径推导 Drupal 模块名称。
 * 例如：`web/modules/custom/my_module/my_module.module` → `my_module`
 */
function moduleNameFromPath(filePath: string): string | null {
  const match = filePath.match(/\/([^/]+)\.[^./]+$/);
  return match ? match[1]! : null;
}

// ---------------------------------------------------------------------------
// 路由提取辅助函数
// ---------------------------------------------------------------------------

/**
 * 从 Drupal `*.routing.yml` 文件中提取路由节点和 handler 引用。
 *
 * Drupal 路由 YAML 格式：
 *
 *   route.name:
 *     path: '/some/path'
 *     defaults:
 *       _controller: '\Drupal\module\Controller\MyController::method'
 *       _form: '\Drupal\module\Form\MyForm'
 *       _title: 'Page title'
 *     requirements:
 *       _permission: 'access content'
 *     methods: [GET, POST]   # 可选
 */
function extractDrupalRoutes(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();

  const lines = content.split('\n');

  type PendingRoute = { name: string; lineNum: number };
  let pending: PendingRoute | null = null;
  let currentPath: string | null = null;
  let handlerRefs: string[] = [];
  let methods: string[] = [];

  const flushRoute = () => {
    if (!pending || !currentPath) return;

    const methodTag = methods.length > 0 ? ` [${methods.join(',')}]` : '';
    const routeNode: Node = {
      id: `route:${filePath}:${pending.lineNum}:${currentPath}`,
      kind: 'route',
      name: `${currentPath}${methodTag}`,
      qualifiedName: `${filePath}::${pending.name}`,
      filePath,
      startLine: pending.lineNum,
      endLine: pending.lineNum,
      startColumn: 0,
      endColumn: 0,
      language: 'yaml',
      updatedAt: now,
    };
    nodes.push(routeNode);

    for (const handler of handlerRefs) {
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handler,
        referenceKind: 'references',
        line: pending.lineNum,
        column: 0,
        filePath,
        language: 'yaml',
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    // 顶层路由名称：无前导空白，以冒号结尾（冒号后无值）
    if (/^\S.*:\s*$/.test(line) && !/^\s/.test(line)) {
      flushRoute();
      pending = { name: trimmed.slice(0, -1).trim(), lineNum: i + 1 };
      currentPath = null;
      handlerRefs = [];
      methods = [];
      continue;
    }

    // path: '/some/path'
    const pathMatch = trimmed.match(/^path:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (pathMatch) {
      currentPath = pathMatch[1]!.trim();
      continue;
    }

    // _controller: '\Drupal\...\Class::method'
    const controllerMatch = trimmed.match(/^_controller:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (controllerMatch) {
      handlerRefs.push(controllerMatch[1]!.trim());
      continue;
    }

    // _form: '\Drupal\...\Form\MyForm'
    const formMatch = trimmed.match(/^_form:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (formMatch) {
      handlerRefs.push(formMatch[1]!.trim());
      continue;
    }

    // _entity_form / _entity_list / _entity_view：entity.type
    const entityMatch = trimmed.match(/^_(entity_form|entity_list|entity_view):\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/);
    if (entityMatch) {
      handlerRefs.push(entityMatch[2]!.trim());
      continue;
    }

    // methods: [GET, POST]  或  methods: [GET]
    const methodsMatch = trimmed.match(/^methods:\s*\[([^\]]+)\]/);
    if (methodsMatch) {
      methods = methodsMatch[1]!.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);
      continue;
    }
  }

  flushRoute();
  return { nodes, references };
}

// ---------------------------------------------------------------------------
// Hook 检测辅助函数
// ---------------------------------------------------------------------------

const HOOK_FILE_EXTENSIONS = ['.module', '.install', '.theme', '.inc'];

function isDrupalHookFile(filePath: string): boolean {
  return HOOK_FILE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/**
 * 从 Drupal PHP 文件中提取 hook 实现引用。
 *
 * 策略 A（主要）：查找包含 `Implements hook_X().` 的文档块，其后紧跟函数定义。
 * 这是 Drupal 编码规范，精确且无假阳性。
 *
 * 策略 B（回退）：对于名称以 `{moduleName}_` 开头的函数，将后缀视为 hook 名称。
 * 可捕获无文档块的 hook，但对非 hook 辅助函数可能产生假阳性。
 *
 * 每个检测到的 hook 从实现函数节点（通过计算与 tree-sitter 相同的 ID 来识别）
 * 向规范 hook 名称（如 `hook_form_alter`）生成 UnresolvedRef。
 */
function extractDrupalHooks(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const references: UnresolvedRef[] = [];

  // 构建函数名 → 1-indexed 行号的映射，覆盖所有顶层函数。
  // 这与 tree-sitter 的行号计算方式一致，用于重建节点 ID。
  const funcLineMap = new Map<string, number>();
  const funcDef = /^function\s+(\w+)\s*\(/gm;
  let fm: RegExpExecArray | null;
  while ((fm = funcDef.exec(content)) !== null) {
    const name = fm[1]!;
    if (!funcLineMap.has(name)) {
      // 行号 = 匹配起始位置前的换行符数量 + 1
      funcLineMap.set(name, content.slice(0, fm.index).split('\n').length);
    }
  }

  const emitHookRef = (hookName: string, funcName: string) => {
    const lineNum = funcLineMap.get(funcName);
    if (lineNum === undefined) return;
    const nodeId = generateNodeId(filePath, 'function', funcName, lineNum);
    references.push({
      fromNodeId: nodeId,
      referenceName: hookName,
      referenceKind: 'references',
      line: lineNum,
      column: 0,
      filePath,
      language: 'php',
    });
  };

  // 策略 A：文档块中包含 `Implements hook_X().`，其后跟函数定义。
  // 文档块与函数之间可以有空行。
  const docblockPattern =
    /\/\*\*[\s\S]*?(?:@|\*\s+)Implements\s+(hook_\w+)\s*\(\)[\s\S]*?\*\/\s*\n(?:\s*\n)*function\s+(\w+)\s*\(/g;
  const docblockMatched = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = docblockPattern.exec(content)) !== null) {
    const [, hookName, funcName] = match;
    emitHookRef(hookName!, funcName!);
    docblockMatched.add(funcName!);
  }

  // 策略 B：对无文档块的函数进行名称模式匹配回退。
  // 仅适用于名称以 {moduleName}_ 开头且未被策略 A 匹配的函数。
  const moduleName = moduleNameFromPath(filePath);
  if (moduleName) {
    const prefix = moduleName + '_';
    for (const [funcName] of funcLineMap) {
      if (docblockMatched.has(funcName)) continue;
      if (!funcName.startsWith(prefix)) continue;
      const hookSuffix = funcName.slice(prefix.length);
      if (!hookSuffix) continue;
      // 向 hook_{suffix} 生成引用——若该 hook 在已索引图谱中有定义
      // （例如 Drupal 核心），解析器会将其链接。
      emitHookRef(`hook_${hookSuffix}`, funcName);
    }
  }

  return { nodes: [], references };
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

export const drupalResolver: FrameworkResolver = {
  name: 'drupal',
  languages: ['php', 'yaml'],

  // Drupal 路由 handler 为 FQCN（`\Drupal\…\Class::method`、单冒号
  // controller-service 形式 `\Drupal\…\Class:method`，或裸 `\…\FormClass`），
  // hook 引用为规范 `hook_*` 名称——两者均不匹配已声明的符号，因此
  // resolveOne 的预过滤器会在 resolve() 运行前将其丢弃。在此声明认领
  // resolve() 处理的形式（与 Rails `controller#action` 声明方式一致）。
  claimsReference(name: string): boolean {
    return (
      name.startsWith('hook_') ||
      name.includes('\\') ||
      /^[A-Za-z_]\w*::?\w+$/.test(name)
    );
  },

  detect(context: ResolutionContext): boolean {
    // 主要方式：composer.json 标识 Drupal 项目/模块/主题/配置文件。
    // contrib 模块的 `require` 通常为空（无 `drupal/*` 依赖），但仍会声明
    // `"name": "drupal/<module>"` 和 `"type": "drupal-module"`，因此也需
    // 检查这些字段——仅检查依赖项会遗漏所有独立的 contrib 模块。
    const composer = context.readFile('composer.json');
    if (composer) {
      try {
        const json = JSON.parse(composer) as {
          name?: string;
          type?: string;
          require?: Record<string, string>;
          'require-dev'?: Record<string, string>;
        };
        if (typeof json.name === 'string' && json.name.startsWith('drupal/')) return true;
        if (typeof json.type === 'string' && json.type.startsWith('drupal-')) return true;
        const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
        if (Object.keys(deps).some((k) => k.startsWith('drupal/'))) return true;
      } catch {
      // malformed composer.json——回退到基于文件的检测
      }
    }

    // 回退（无 composer 的模块，或非 Drupal 的 composer.json）：
    // Drupal 不可混淆的特征是 `*.info.yml` 清单文件与 Drupal PHP/路由文件并存。
    // 两者都要求，避免其他位置的 `.info.yml` 触发误判。
    const files = context.getAllFiles();
    const hasInfoYml = files.some((f) => f.endsWith('.info.yml'));
    if (!hasInfoYml) return false;
    return files.some(
      (f) =>
        f.endsWith('.routing.yml') ||
        f.endsWith('.module') ||
        f.endsWith('.install') ||
        f.endsWith('.theme')
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName;

    // _controller：'\Drupal\module\...\ClassName::methodName'（双冒号）或
    // 单冒号 controller-service 形式 '\Drupal\...\ClassName:methodName'。
    const controllerMatch = name.match(/^\\?(?:Drupal\\[^:]+\\)?([^\\:]+):{1,2}(\w+)$/);
    if (controllerMatch) {
      const [, className, methodName] = controllerMatch;
      const classNodes = context.getNodesByName(className!);
      for (const cls of classNodes) {
        if (cls.kind !== 'class') continue;
        const fileNodes = context.getNodesInFile(cls.filePath);
        const method = fileNodes.find((n) => n.kind === 'method' && n.name === methodName);
        if (method) {
          return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' };
        }
        return { original: ref, targetNodeId: cls.id, confidence: 0.7, resolvedBy: 'framework' };
      }
    }

    // _form / _entity_form：'\Drupal\module\...\ClassName'（裸 FQCN，无方法名）
    if (name.includes('\\') && !name.includes(':')) {
      const className = lastSegment(name);
      if (className) {
        const classNodes = context.getNodesByName(className);
        const cls = classNodes.find((n) => n.kind === 'class');
        if (cls) {
          return { original: ref, targetNodeId: cls.id, confidence: 0.85, resolvedBy: 'framework' };
        }
      }
    }

    // hook_X——在 hook 文件中查找名称以 _{hookSuffix} 结尾的任意函数
    if (name.startsWith('hook_')) {
      const hookSuffix = name.slice(5); // 去除 'hook_'
      const candidates = context.getNodesByKind('function').filter(
        (n) => n.name.endsWith(`_${hookSuffix}`) && isDrupalHookFile(n.filePath)
      );
      if (candidates.length > 0) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (filePath.endsWith('.routing.yml')) {
      return extractDrupalRoutes(filePath, content);
    }

    if (isDrupalHookFile(filePath) || filePath.endsWith('.php')) {
      return extractDrupalHooks(filePath, content);
    }

    return { nodes: [], references: [] };
  },
};
