/**
 * NestJS 框架解析器
 *
 * 处理 NestJS 基于装饰器的路由，覆盖以下传输层：
 *   - HTTP：         @Controller(prefix) + @Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All
 *   - GraphQL：      @Resolver + @Query/@Mutation/@Subscription
 *   - 微服务：       @MessagePattern / @EventPattern
 *   - WebSockets：   @WebSocketGateway(namespace) + @SubscribeMessage(event)
 *
 * 与其他框架提取器相同，这里采用正则扫描源码（剥离注释后），而非 AST 遍历。
 * NestJS 与 Spring/ASP.NET 有两点不同，本解析器需要处理：
 *
 *   1. HTTP 路由的路径分散在两个装饰器中——类级别的 `@Controller` 前缀和
 *      方法级别的 `@Get`/`@Post` 路径——两者都可能为空
 *      （`@Controller()`、`@Get()`）。我们将每个方法装饰器与其所在的类配对，
 *      然后拼接两段路径。
 *
 *   2. `@Query()` 存在重载：它既是来自 `@nestjs/graphql` 的 GraphQL *方法*
 *      装饰器，也是来自 `@nestjs/common` 的 REST *参数*装饰器。只有当它
 *      位于 `@Resolver` 类内部时，才将其视为 GraphQL，这是区分两者的依据。
 */

import { Node } from '../../types';
import {
  FrameworkResolver,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';

// ---------------------------------------------------------------------------
// 公开接口——参见文件顶部注释。本文件负责四项 NestJS 关注点：HTTP 路由、
// GraphQL 操作、微服务处理器、WebSocket 处理器，以及（在下方 postExtract 中）
// 跨文件的 RouterModule 前缀处理。
// ---------------------------------------------------------------------------

type JsLang = 'typescript' | 'javascript';

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];
const GQL_OPS = ['Query', 'Mutation', 'Subscription'];

export const nestjsResolver: FrameworkResolver = {
  name: 'nestjs',
  languages: ['typescript', 'javascript'],

  detect(context: ResolutionContext): boolean {
    // 主路径，快速：检查 package.json 中是否有任何 @nestjs/* 依赖。
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (Object.keys(deps).some((k) => k.startsWith('@nestjs/'))) {
          return true;
        }
      } catch {
        // JSON 格式无效——继续扫描源码。
      }
    }

    // 回退：在按约定命名的文件中查找 NestJS 特有装饰器。
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (
        file.endsWith('.controller.ts') ||
        file.endsWith('.controller.js') ||
        file.endsWith('.module.ts') ||
        file.endsWith('.resolver.ts') ||
        file.endsWith('.gateway.ts')
      ) {
        const content = context.readFile(file);
        if (
          content &&
          (content.includes('@nestjs/') ||
            content.includes('@Controller') ||
            content.includes('@Module(') ||
            content.includes('@Resolver(') ||
            content.includes('@WebSocketGateway('))
        ) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 解析 provider/controller 引用（例如构造函数注入的 `UsersService`）
    // 到其对应的类，优先按 Nest 文件命名约定（`*.service.ts`、`*.controller.ts` 等）。
    for (const [suffix, convention] of PROVIDER_CONVENTIONS) {
      if (!suffix.test(ref.referenceName)) continue;
      const candidates = context
        .getNodesByName(ref.referenceName)
        .filter((n) => n.kind === 'class');
      if (candidates.length === 0) return null;
      const preferred = candidates.find((n) => n.filePath.includes(convention));
      const target = preferred ?? candidates[0]!;
      return {
        original: ref,
        targetNodeId: target.id,
        confidence: preferred ? 0.85 : 0.7,
        resolvedBy: 'framework',
      };
    }
    return null;
  },

  extract(filePath, content) {
    if (!/\.(m?js|tsx?|cjs)$/.test(filePath)) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang = detectLanguage(filePath);
    const safe = stripCommentsForRegex(content, lang);

    const addRoute = (
      index: number,
      method: string,
      path: string,
      length: number,
      handler: string | null
    ): void => {
      const line = lineAt(safe, index);
      const node: Node = {
        id: `route:${filePath}:${line}:${method}:${path}`,
        kind: 'route',
        name: `${method} ${path}`,
        qualifiedName: `${filePath}::${method}:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: length,
        language: lang,
        updatedAt: now,
      };
      nodes.push(node);
      if (handler) {
        references.push({
          fromNodeId: node.id,
          referenceName: handler,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    };

    const scopes = buildClassScopes(safe);

    // HTTP 路由：方法装饰器路径与外层控制器前缀拼接。
    for (const hit of findDecorators(safe, HTTP_METHODS)) {
      const scope = scopeFor(scopes, hit.index);
      const prefix = scope && scope.kind === 'controller' ? scope.prefix : '';
      const path = joinHttpPath(prefix, parseStringArg(hit.args));
      addRoute(hit.index, hit.name.toUpperCase(), path, hit.length, methodNameAfter(safe, hit.end));
    }

    // GraphQL 操作：仅在 @Resolver 类内部（用于区分 REST `@Query()` 参数装饰器，
    // 后者位于 @Controller 类中）。
    for (const hit of findDecorators(safe, GQL_OPS)) {
      const scope = scopeFor(scopes, hit.index);
      if (!scope || scope.kind !== 'resolver') continue;
      const handler = methodNameAfter(safe, hit.end);
      const name = parseGraphqlName(hit.args, handler);
      addRoute(hit.index, hit.name.toUpperCase(), name, hit.length, handler);
    }

    // 微服务消息/事件处理器。
    for (const hit of findDecorators(safe, ['MessagePattern', 'EventPattern'])) {
      const verb = hit.name === 'EventPattern' ? 'EVENT' : 'MESSAGE';
      const handler = methodNameAfter(safe, hit.end);
      addRoute(hit.index, verb, parseStringArg(hit.args) || handler || '', hit.length, handler);
    }

    // WebSocket 消息处理器，当存在网关命名空间时添加前缀。
    for (const hit of findDecorators(safe, ['SubscribeMessage'])) {
      const scope = scopeFor(scopes, hit.index);
      const namespace = scope && scope.kind === 'gateway' ? scope.prefix : '';
      const handler = methodNameAfter(safe, hit.end);
      const event = parseStringArg(hit.args) || handler || '';
      addRoute(hit.index, 'WS', namespace ? `${namespace}:${event}` : event, hit.length, handler);
    }

    return { nodes, references };
  },

  /**
   * 针对 `RouterModule.register([...])` 的跨文件后处理。每个文件的 extract()
   * 只能看到 `@Controller(prefix) + @Get(path)`——无法获知同级 `app.module.ts`
   * 中类似如下的路由前缀：
   *
   *   RouterModule.register([
   *     { path: 'admin', module: AdminModule, children: [
   *       { path: 'users', module: UsersModule } ] } ])
   *
   * 本轮次扫描所有 `*.module.{ts,js}` 文件，遍历注册树构建 `Module → /full/prefix`
   * 映射，再遍历每个 `@Module({ controllers: [...] })` 构建 `Controller → Module`
   * 映射，最终重写受影响的路由节点，使 `GET /` 变为 `GET /admin/users`
   * （同一模块下 `@Controller('foo') + @Get(':id')` 变为 `GET /admin/users/foo/:id`）。
   *
   * 路由节点的 `id` 和 `qualifiedName` 在更新中刻意保持不变：`id` 因为现有的
   * 路由→处理器边引用了它；`qualifiedName` 仍然编码了文件内的原始 `method:path`
   * ——这使本轮次具有幂等性（无论已执行多少次前缀操作，再次运行均能恢复相同输入）。
   */
  postExtract(context: ResolutionContext): Node[] {
    const moduleToPrefix = new Map<string, string>();
    const controllerToModule = new Map<string, string>();

    for (const filePath of context.getAllFiles()) {
      if (!/\.module\.(m?[jt]s|cjs)$/.test(filePath)) continue;
      const content = context.readFile(filePath);
      if (!content) continue;
      const safe = stripCommentsForRegex(content, detectLanguage(filePath));
      collectRouterModuleRegistrations(safe, moduleToPrefix);
      collectModuleControllers(safe, controllerToModule);
    }

    const controllerToPrefix = new Map<string, string>();
    for (const [controller, module] of controllerToModule) {
      const prefix = moduleToPrefix.get(module);
      // `''` 和 `'/'` 是无操作前缀；跳过它们以避免执行
      // 将 name 设为与当前值相同的无效更新。
      if (prefix && prefix !== '' && prefix !== '/') {
        controllerToPrefix.set(controller, prefix);
      }
    }

    if (controllerToPrefix.size === 0) return [];

    const updates: Node[] = [];
    for (const [controllerName, prefix] of controllerToPrefix) {
      const classes = context
        .getNodesByName(controllerName)
        .filter((n) => n.kind === 'class');
      for (const cls of classes) {
        const routes = context
          .getNodesInFile(cls.filePath)
          .filter((n) => n.kind === 'route');
        for (const route of routes) {
      // 一个文件中可以存在多个控制器（已由现有的"将方法归属到正确控制器"
      // 测试覆盖）；每条路由必须关联到其行范围包含该路由的控制器。
          if (route.startLine < cls.startLine || route.startLine > cls.endLine) {
            continue;
          }
          const updated = applyModulePrefix(route, prefix);
          if (updated && updated.name !== route.name) updates.push(updated);
        }
      }
    }

    return updates;
  },
};

// ---------------------------------------------------------------------------
// Provider 解析约定
// ---------------------------------------------------------------------------

const PROVIDER_CONVENTIONS: Array<[RegExp, string]> = [
  [/Service$/, '.service.'],
  [/Controller$/, '.controller.'],
  [/Resolver$/, '.resolver.'],
  [/Gateway$/, '.gateway.'],
  [/Repository$/, '.repository.'],
  [/Guard$/, '.guard.'],
  [/Interceptor$/, '.interceptor.'],
  [/Pipe$/, '.pipe.'],
  [/Module$/, '.module.'],
];

// ---------------------------------------------------------------------------
// 装饰器扫描
// ---------------------------------------------------------------------------

interface DecoratorHit {
  /** 不含前导 `@` 的装饰器名称（如 `Get`）。 */
  name: string;
  /** 装饰器括号内的原始文本。 */
  args: string;
  /** 前导 `@` 在（剥离注释后的）源码中的索引。 */
  index: number;
  /** 装饰器闭合 `)` 之后的索引。 */
  end: number;
  /** 整个 `@Name(...)` 装饰器的字符长度。 */
  length: number;
}

/**
 * 查找所有名称在 `names` 中的 `@Name(...)` 装饰器。使用字符串感知的平衡括号
 * 读取器解析参数列表，以便像 `@Query(() => [User])` 这样含类型 thunk 的装饰器
 * 能被完整捕获，而不会在内层 `()` 处截断。
 */
function findDecorators(safe: string, names: string[]): DecoratorHit[] {
  const hits: DecoratorHit[] = [];
  const re = new RegExp(`@(${names.join('|')})\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(safe)) !== null) {
    const openIndex = m.index + m[0].length - 1; // position of '('
    const parsed = readArgs(safe, openIndex);
    if (!parsed) continue;
    hits.push({
      name: m[1]!,
      args: parsed.args,
      index: m.index,
      end: parsed.end,
      length: parsed.end - m.index,
    });
    re.lastIndex = parsed.end; // resume past the args so nested text isn't re-scanned
  }
  return hits;
}

/**
 * 从 `openIndex`（必须指向 `(`）开始读取平衡的 `(...)`。
 * 字符串感知，因此字符串字面量内的括号不会破坏计数。
 * 返回内部文本及闭合 `)` 之后的索引。
 */
function readArgs(s: string, openIndex: number): { args: string; end: number } | null {
  if (s[openIndex] !== '(') return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIndex; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { args: s.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * 从方法装饰器的 `)` 之后开始，返回被装饰方法的名称。跳过其间的其他堆叠
 * 装饰器（`@UseGuards(...)`、`@HttpCode(204)` 等）以及访问/async 修饰符。
 */
function methodNameAfter(safe: string, start: number): string | null {
  let i = start;
  const ws = /\s*/y;
  const decoName = /@[\w.]+/y;
  const modifier = /(?:public|private|protected|async|static)\b/y;
  const ident = /([A-Za-z_$][\w$]*)\s*\(/y;

  const eatWs = (): void => {
    ws.lastIndex = i;
    if (ws.exec(safe)) i = ws.lastIndex;
  };

    // 跳过堆叠的装饰器。
  for (;;) {
    eatWs();
    if (safe[i] !== '@') break;
    decoName.lastIndex = i;
    if (!decoName.exec(safe)) break;
    i = decoName.lastIndex;
    eatWs();
    if (safe[i] === '(') {
      const parsed = readArgs(safe, i);
      if (!parsed) return null;
      i = parsed.end;
    }
  }

  // 跳过访问/async/static 修饰符。
  for (;;) {
    eatWs();
    modifier.lastIndex = i;
    if (modifier.exec(safe) && modifier.lastIndex > i) {
      i = modifier.lastIndex;
      continue;
    }
    break;
  }

  eatWs();
  ident.lastIndex = i;
  const m = ident.exec(safe);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// 类作用域（controller / resolver / gateway 边界）
// ---------------------------------------------------------------------------

type ClassKind = 'controller' | 'resolver' | 'gateway' | 'other';

interface ClassScope {
  kind: ClassKind;
  /** HTTP 前缀（controller）或 WS 命名空间（gateway）；其他情况为 ''。 */
  prefix: string;
  start: number;
  end: number;
}

/**
 * 构建按位置排序的类级装饰器作用域列表。每个作用域从其装饰器延伸至下一个
 * 类装饰器（任意类型），使方法装饰器能找到其所属的类，无论文件中有多少个类。
 */
function buildClassScopes(safe: string): ClassScope[] {
  const defs: Array<{ kind: ClassKind; name: string; prefixOf: (a: string) => string }> = [
    { kind: 'controller', name: 'Controller', prefixOf: parseControllerPrefix },
    { kind: 'resolver', name: 'Resolver', prefixOf: () => '' },
    { kind: 'gateway', name: 'WebSocketGateway', prefixOf: parseGatewayNamespace },
    { kind: 'other', name: 'Injectable', prefixOf: () => '' },
    { kind: 'other', name: 'Module', prefixOf: () => '' },
    { kind: 'other', name: 'Catch', prefixOf: () => '' },
  ];

  const raw: Array<{ kind: ClassKind; prefix: string; index: number }> = [];
  for (const def of defs) {
    for (const hit of findDecorators(safe, [def.name])) {
      raw.push({ kind: def.kind, prefix: def.prefixOf(hit.args), index: hit.index });
    }
  }
  raw.sort((a, b) => a.index - b.index);

  return raw.map((r, i) => ({
    kind: r.kind,
    prefix: r.prefix,
    start: r.index,
    end: i + 1 < raw.length ? raw[i + 1]!.index : safe.length,
  }));
}

function scopeFor(scopes: ClassScope[], index: number): ClassScope | null {
  for (const s of scopes) {
    if (index >= s.start && index < s.end) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/** 参数中第一个字符串字面量，或 ''（支持 `'x'`、`{ k: 'x' }` 等形式）。 */
function parseStringArg(args: string): string {
  const m = args.match(/['"`]([^'"`]*)['"`]/);
  return m ? m[1]! : '';
}

/** `@Controller('users')` | `@Controller({ path: 'users', host })` | `@Controller(['a','b'])` | `@Controller()`。 */
function parseControllerPrefix(args: string): string {
  const obj = args.match(/path\s*:\s*['"`]([^'"`]*)['"`]/);
  if (obj) return obj[1]!;
  return parseStringArg(args);
}

/** `@WebSocketGateway({ namespace: 'chat' })` | `@WebSocketGateway(81, { namespace: '/chat' })` | `@WebSocketGateway()`。 */
function parseGatewayNamespace(args: string): string {
  const m = args.match(/namespace\s*:\s*['"`]([^'"`]*)['"`]/);
  return m ? m[1]! : '';
}

/**
 * GraphQL 操作名称。优先使用显式的 `{ name: 'x' }` 或前导字符串字面量
 * （`@Query('users')`）；否则字段名默认为处理器方法名。避免将 `description`
 * 字符串误认为名称。
 */
function parseGraphqlName(args: string, handler: string | null): string {
  const named = args.match(/name\s*:\s*['"`]([^'"`]*)['"`]/);
  if (named) return named[1]!;
  const lead = args.match(/^\s*['"`]([^'"`]*)['"`]/);
  if (lead) return lead[1]!;
  return handler ?? '';
}

// ---------------------------------------------------------------------------
// 路径辅助函数
// ---------------------------------------------------------------------------

/** 将控制器前缀和方法路径拼接为规范化的单个 `/path`。 */
function joinHttpPath(prefix: string, sub: string): string {
  const parts = [prefix, sub]
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return '/' + parts.join('/');
}

function lineAt(safe: string, index: number): number {
  return safe.slice(0, index).split('\n').length;
}

function detectLanguage(filePath: string): JsLang {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript';
  return 'javascript';
}

// ---------------------------------------------------------------------------
// RouterModule + @Module 遍历器（由 postExtract 调用）
// ---------------------------------------------------------------------------

/**
 * 遍历每个 `RouterModule.register([...])` 调用（以及等价的
 * `RouterModule.forRoot([...])` 和 `forChild([...])` 别名），并将
 * `Module → /full/prefix` 写入 `out`。递归的 `children` 数组继承其父级前缀。
 *
 * 首次写入优先：若同一模块出现在两个注册中，保留第一个前缀而不覆盖。
 * NestJS 本身的行为与此相同。
 */
function collectRouterModuleRegistrations(safe: string, out: Map<string, string>): void {
  const re = /\bRouterModule\s*\.\s*(?:register|forRoot|forChild)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(safe)) !== null) {
    const openIndex = m.index + m[0].length - 1;
    const parsed = readArgs(safe, openIndex);
    if (!parsed) continue;
    const items = parseRoutesArray(parsed.args);
    walkRoutesTree(items, '', out);
    re.lastIndex = parsed.end;
  }
}

interface RouteItem {
  path: string;
  moduleName: string | null;
  children: RouteItem[];
}

/**
 * 将 `[ {...}, {...} ]` 参数列表解析为 `RouteItem` 列表。参数应为内联字面量——
 * 不追踪文件中早先声明的 `const routes: Routes = [...]` 引用
 * （实际中很少见；注册通常是内联的）。
 */
function parseRoutesArray(args: string): RouteItem[] {
  const trimmed = args.trim();
  if (!trimmed.startsWith('[')) return [];
  // 去掉外层 [ ... ]，保持括号平衡。
  const close = matchingClose(trimmed, 0);
  if (close < 0) return [];
  return parseRouteObjects(trimmed.slice(1, close));
}

function parseRouteObjects(s: string): RouteItem[] {
  const items: RouteItem[] = [];
  for (const obj of splitTopLevelObjects(s)) {
    const path = parseStringField(obj, 'path');
    const moduleName = parseIdentField(obj, 'module');
    const childrenStr = parseArrayField(obj, 'children');
    const children = childrenStr ? parseRouteObjects(childrenStr) : [];
    items.push({ path, moduleName, children });
  }
  return items;
}

function walkRoutesTree(
  items: RouteItem[],
  parentPrefix: string,
  out: Map<string, string>
): void {
  for (const item of items) {
    const myPrefix = joinHttpPath(parentPrefix, item.path);
    if (item.moduleName && !out.has(item.moduleName)) {
      out.set(item.moduleName, myPrefix);
    }
    if (item.children.length > 0) {
      walkRoutesTree(item.children, myPrefix, out);
    }
  }
}

/**
 * 遍历每个 `@Module(...)` 装饰器，根据装饰器的 `controllers: [...]` 字段
 * 以及装饰器后紧跟的类声明（跳过堆叠装饰器和 export/default/abstract 修饰符），
 * 将 `Controller → enclosingModuleClassName` 写入 `out`。
 */
function collectModuleControllers(safe: string, out: Map<string, string>): void {
  for (const hit of findDecorators(safe, ['Module'])) {
    const className = classNameAfter(safe, hit.end);
    if (!className) continue;
    for (const controller of parseControllersField(hit.args)) {
      // 首次写入优先，与 RouterModule 相同；若一个控制器同时出现在两个模块中，
      // 取源码中最早声明的那个。
      if (!out.has(controller)) out.set(controller, className);
    }
  }
}

function parseControllersField(args: string): string[] {
  const inner = parseArrayField(args, 'controllers');
  if (inner === null) return [];
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

/**
 * 从类装饰器的 `)` 之后开始，返回被装饰类的名称。镜像方法版的
 * `methodNameAfter`：跳过堆叠装饰器以及 `export`/`default`/`abstract` 修饰符。
 */
function classNameAfter(safe: string, start: number): string | null {
  let i = start;
  const ws = /\s*/y;
  const decoName = /@[\w.]+/y;
  const classDecl = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/y;

  const eatWs = (): void => {
    ws.lastIndex = i;
    if (ws.exec(safe)) i = ws.lastIndex;
  };

  for (;;) {
    eatWs();
    if (safe[i] !== '@') break;
    decoName.lastIndex = i;
    if (!decoName.exec(safe)) break;
    i = decoName.lastIndex;
    eatWs();
    if (safe[i] === '(') {
      const parsed = readArgs(safe, i);
      if (!parsed) return null;
      i = parsed.end;
    }
  }

  eatWs();
  classDecl.lastIndex = i;
  const m = classDecl.exec(safe);
  return m ? m[1]! : null;
}

/**
 * 通过在原始文件内路径前加上 `prefix` 来重新计算路由节点的 `name`。
 * 原始路径从 `qualifiedName` 中恢复，该字段由每个文件的 extract 以
 * `${filePath}::${method}:${path}` 格式写入，本轮次刻意不对其修改——
 * 这正是保证更新幂等性的关键。
 */
function applyModulePrefix(route: Node, prefix: string): Node | null {
  const sep = '::';
  const idx = route.qualifiedName.indexOf(sep);
  if (idx < 0) return null;
  const tail = route.qualifiedName.slice(idx + sep.length);
  const colon = tail.indexOf(':');
  if (colon < 0) return null;
  const method = tail.slice(0, colon);
  const original = tail.slice(colon + 1);
  const newName = `${method} ${joinHttpPath(prefix, original)}`;
  return { ...route, name: newName, updatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// 小型字符串工具函数（对象/数组字面量分割器）
// ---------------------------------------------------------------------------

/** 返回闭合 `open` 处括号的索引，若未找到则返回 -1。 */
function matchingClose(s: string, open: number): number {
  const opener = s[open];
  if (opener !== '[' && opener !== '{' && opener !== '(') return -1;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 将 `s` 拆分为每个顶层对象字面量的内容。括号和字符串字面量均做平衡处理，
 * 使对象内部嵌套的数组/对象/字符串不会导致提前分割。
 */
function splitTopLevelObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let objStart = -1;
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (depth === 0 && ch === '{') {
      depth = 1;
      objStart = i;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0 && objStart >= 0 && ch === '}') {
        out.push(s.slice(objStart + 1, i));
        objStart = -1;
      }
    }
  }
  return out;
}

/**
 * 从一个对象字面量的主体中读取字符串值字段——`key: 'value'`。
 * 若不存在则返回 `''`。开头的字符类用于防止名称尾部包含目标字符串的字段被匹配。
 */
function parseStringField(obj: string, name: string): string {
  const re = new RegExp(`(?:^|[,{\\s])${name}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`);
  const m = obj.match(re);
  return m ? m[1]! : '';
}

/** 从一个对象主体中读取标识符值字段——`key: SomeIdent`。 */
function parseIdentField(obj: string, name: string): string | null {
  const re = new RegExp(`(?:^|[,{\\s])${name}\\s*:\\s*([A-Za-z_$][\\w$]*)`);
  const m = obj.match(re);
  return m ? m[1]! : null;
}

/** 将数组值字段——`key: [ ... ]`——作为原始内部文本读取。 */
function parseArrayField(obj: string, name: string): string | null {
  const re = new RegExp(`(?:^|[,{\\s])${name}\\s*:\\s*\\[`);
  const m = re.exec(obj);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchingClose(obj, open);
  if (close < 0) return null;
  return obj.slice(open + 1, close);
}
