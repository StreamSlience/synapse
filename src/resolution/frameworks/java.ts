/**
 * Java 框架解析器
 *
 * 处理 Spring Boot 及通用 Java 模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const springResolver: FrameworkResolver = {
  name: 'spring',
  languages: ['java', 'kotlin', 'yaml', 'properties'],

  claimsReference(name: string): boolean {
    // `@ConfigurationProperties(prefix="app.cache")` 会生成一个引用，其名称携带
    // `:prefix` 哨兵——不存在拼写完全相同的已声明符号，因此解析器的名称预过滤
    // 会将其丢弃。在此选择让这些引用通过。
    return name.endsWith(':prefix');
  },

  detect(context: ResolutionContext): boolean {
    // 检查包含 Spring 的 pom.xml
    const pomXml = context.readFile('pom.xml');
    if (pomXml && (pomXml.includes('spring-boot') || pomXml.includes('springframework'))) {
      return true;
    }

    // 检查包含 Spring 的 build.gradle
    const buildGradle = context.readFile('build.gradle');
    if (buildGradle && (buildGradle.includes('spring-boot') || buildGradle.includes('springframework'))) {
      return true;
    }

    const buildGradleKts = context.readFile('build.gradle.kts');
    if (buildGradleKts && (buildGradleKts.includes('spring-boot') || buildGradleKts.includes('springframework'))) {
      return true;
    }

    // 检查 Java 文件中的 Spring 注解
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.java')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('@SpringBootApplication') ||
          content.includes('@RestController') ||
          content.includes('@Service') ||
          content.includes('@Repository')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Spring 配置键引用——`@Value("${key}")` （单个叶节点）和
    // `@ConfigurationProperties(prefix="X")`（整个子树，在 extractSpringValueBindings
    // 中用 `:prefix` 后缀标记）。查找通过 Spring 的宽松绑定进行
    // （kebab/camel/snake → 规范小写）。
    if (ref.referenceName.endsWith(':prefix')) {
      const prefix = ref.referenceName.slice(0, -':prefix'.length);
      const canonPrefix = canonicalConfigKey(prefix);
      // 优先精确前缀匹配（一个节点 = 前缀子树）。由于没有节点级子树表示，
      // 映射到最近匹配的键。
      const candidates = context.getNodesByKind('constant').filter(
        (n) => (n.language === 'yaml' || n.language === 'properties')
          && canonicalConfigKey(n.qualifiedName).startsWith(canonPrefix),
      );
      if (candidates.length === 0) return null;
      // 选取规范名称最短的——它是最近的绑定点
      // （对于 prefix=`app.cache`，`app.cache` 优先于 `app.cache.name.user-token`）。
      const best = candidates.reduce((a, b) =>
        canonicalConfigKey(a.qualifiedName).length <= canonicalConfigKey(b.qualifiedName).length ? a : b,
      );
      return { original: ref, targetNodeId: best.id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.includes('.') && ref.language !== 'java' && ref.language !== 'kotlin') {
      // Spring 配置点分键——仅当源语言为 Java/Kotlin 时
      // （绑定来自 `@Value`）。跳过碰巧含有点号的非 Spring 引用。
    }
    if (
      (ref.language === 'java' || ref.language === 'kotlin') &&
      ref.referenceName.includes('.') &&
      !ref.referenceName.includes('::') &&
      // 排除方法调用风格（单点，两侧均为小驼峰）。Spring 配置键
      // 通常有 3 个以上分段并含有连字符/短划线；无法完美过滤，
      // 但跳过单点可使查找更精准。
      ref.referenceName.split('.').length >= 2
    ) {
      const canonRef = canonicalConfigKey(ref.referenceName);
      const candidates = context.getNodesByKind('constant').filter(
        (n) => n.kind === 'constant'
          && (n.language === 'yaml' || n.language === 'properties')
          && canonicalConfigKey(n.qualifiedName) === canonRef,
      );
      if (candidates.length === 1) {
        return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
      }
      if (candidates.length > 1) {
        // 多个特定 profile 的文件（application-dev.yml +
        // application-prod.yml）可以定义相同的键。优先选取 profile 后缀
        // 最短的（当基础 `application.yml` 与 profile 变体同时存在时，
        // 基础文件优先），然后按字母顺序排序以确保跨重建时的结果一致。
        const score = (n: Node) => {
          const base = n.filePath.split('/').pop() ?? '';
          const isBase = /^(application|bootstrap)\.(yml|yaml|properties)$/i.test(base);
          return (isBase ? 0 : 1) * 1000 + base.length;
        };
        const best = candidates.reduce((a, b) => (score(a) <= score(b) ? a : b));
        return { original: ref, targetNodeId: best.id, confidence: 0.75, resolvedBy: 'framework' };
      }
    }

    // 模式 1：Service 引用（依赖注入）
    if (ref.referenceName.endsWith('Service')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, SERVICE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 2：Repository 引用
    if (ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, REPO_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：Controller 引用
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CONTROLLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 4：Entity/Model 引用
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, ENTITY_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 5：Component 引用
    if (ref.referenceName.endsWith('Component') || ref.referenceName.endsWith('Config')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, COMPONENT_DIRS, context);
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
    // Spring 配置文件（application.yml / application.properties /
    // bootstrap.yml + 各 profile 变体）在框架路径上提取，而非在语言提取器中，
    // 这样键就成为 `@Value("${k}")` 引用可以解析到的一等节点。
    if (isSpringConfigFile(filePath)) {
      return extractSpringConfig(filePath, content);
    }
    // Spring Boot 同时用于 Java 和 Kotlin（相同的 @GetMapping 等注解）；
    // 区别在于方法语法——Kotlin `fun name(...)` vs Java `public X name(...)`
    // ——在下方的方法 regex 中处理。
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java';
    const safe = stripCommentsForRegex(content, 'java');

    // 类级别的 @RequestMapping 前缀（尾部指向 `class` 的 @RequestMapping）。
    // 拼接到每个方法的路径上——关键是不将其本身视为一个路由
    // （旧 regex 会这样做，创建一个虚假的类路由，并遗漏每个
    // BARE 方法映射，如路径在类上的 `@PostMapping`）。
    let classPrefix = '';
    const cls = /@RequestMapping\s*\(([^)]*)\)\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.exec(safe);
    if (cls) classPrefix = parseMappingPath(cls[1]!);

    const VERB: Record<string, string> = {
      GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE',
    };
    // 动词专属方法映射——始终位于方法级别，BARE 或带路径。
    const mappingRegex = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b\s*(\([^)]*\))?/g;
    let match: RegExpExecArray | null;
    while ((match = mappingRegex.exec(safe)) !== null) {
      const method = VERB[match[1]!]!;
      const sub = parseMappingPath((match[2] || '').replace(/^\(|\)$/g, ''));
      const routePath = joinPath(classPrefix, sub);
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: lang,
        updatedAt: now,
      };
      nodes.push(routeNode);

      // 它所装饰的方法：之后第一个声明的方法（跳过堆叠的注解；
      // Java 在名称前放返回类型）。有界以避免抓取过远的方法。
      const tail = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      const methodMatch = tail.match(/\bfun\s+(\w+)\s*\(|\b(?:public|private|protected)\s+[^;{=]*?\s+(\w+)\s*\(/);
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: (methodMatch[1] ?? methodMatch[2])!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }

    // 方法级别的 @RequestMapping（旧风格：方法上的
    // `@RequestMapping(value="/x", method=RequestMethod.GET)`）。
    // 类级别的 @RequestMapping 是前缀（上方已处理）——此处跳过以避免重复计数。
    const reqRe = /@RequestMapping\b\s*(\([^)]*\))?/g;
    while ((match = reqRe.exec(safe)) !== null) {
      const args = (match[1] || '').replace(/^\(|\)$/g, '');
      const after = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      if (/^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.test(after)) continue; // 类级别前缀
      const methodMatch = after.match(/\bfun\s+(\w+)\s*\(|\b(?:public|private|protected)\s+[^;{=]*?\s+(\w+)\s*\(/);
      if (!methodMatch) continue;
      const verbM = args.match(/method\s*=\s*(?:RequestMethod\.)?(\w+)/);
      const method = verbM ? verbM[1]!.toUpperCase() : 'ANY';
      const routePath = joinPath(classPrefix, parseMappingPath(args));
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: lang, updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: (methodMatch[1] ?? methodMatch[2])!,
        referenceKind: 'references',
        line, column: 0, filePath, language: lang,
      });
    }

    // `@Value("${key}")` 和 `@ConfigurationProperties(prefix="...")`——
    // 绑定 Java/Kotlin 源码中的 Spring 配置键引用。引用目标是
    // extractSpringConfig 生成的对应 YAML/properties 叶键节点；
    // springResolver.resolve 通过宽松绑定（kebab/camel/snake 折叠）查找它。
    extractSpringValueBindings(filePath, safe, lang, now, nodes, references);

    return { nodes, references };
  },
};

/** Spring 配置文件模式：application(-profile)?.{yml,yaml,properties} +
 * bootstrap 变体。匹配文件名而非路径，因此将 `application.yml`
 * 放在 `src/main/resources` 和 `src/test/resources` 下的项目都能被识别。 */
function isSpringConfigFile(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? '';
  return /^(application|bootstrap)(-[\w.-]+)?\.(yml|yaml|properties)$/i.test(base);
}

/**
 * 解析 Spring 配置文件（YAML 或 .properties），为每个叶键生成一个 `constant`
 * 节点，`qualifiedName` 为点分路径。叶键是 `@Value("${k}")` 引用命中的目标；
 * Spring 的 `@Value` 不绑定中间键（`@ConfigurationProperties` 类绑定子树，
 * 这些引用在查找时通过前缀后缀匹配解析）。
 */
function extractSpringConfig(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const isProperties = /\.properties$/i.test(filePath);
  const lang = isProperties ? 'properties' : 'yaml';
  const now = Date.now();

  const emitLeaf = (dottedKey: string, line: number, valueText: string) => {
    if (!dottedKey) return;
    nodes.push({
      id: `spring-config:${filePath}:${line}:${dottedKey}`,
      kind: 'constant',
      name: dottedKey.split('.').pop() ?? dottedKey,
      qualifiedName: dottedKey,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: valueText.length,
      language: lang,
      signature: dottedKey,
      // 安全（#383）：只存储键，绝不存储值。配置文件中
      // 经常包含密钥（数据库密码、API 密钥、带凭据的 JDBC URL），
      // 将值暴露在此会将其推入智能体上下文
      // （通过 synapse_node/explore 输出的 docstring 呈现）。
      // `@Value`/`@ConfigurationProperties` 解析只需要键；
      // 真正需要值的智能体可以直接读取文件。
      updatedAt: now,
    });
  };

  if (isProperties) {
    // Properties 格式：`k1.k2.k3 = value`（或 `:` 分隔符，或无值）。
    // 以 `#`/`!` 开头的行是注释。反斜杠续行合法但少见；
    // 我们不尝试拼接它们（续行的值仍属于同一键）。
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const sep = (() => {
        for (let j = 0; j < raw.length; j++) {
          const ch = raw[j];
          if (ch === '=' || ch === ':') return j;
          if (ch === '\\' && raw[j + 1]) { j++; continue; }
        }
        return -1;
      })();
      if (sep < 0) continue;
      const key = raw.slice(0, sep).trim();
      const val = raw.slice(sep + 1).trim();
      emitLeaf(key, i + 1, val);
    }
    return { nodes, references: [] };
  }

  // YAML：基于缩进。我们维护一个 (indent, key) 栈，通过将祖先键用 `.` 连接
  // 来构建点分路径。叶节点是同行有值的行（在 `:` 之后）。列表项、
  // 流式标量和 `---` 分隔符被忽略——它们无法绑定到 `@Value`。
  const stack: Array<{ indent: number; key: string }> = [];
  const yamlLines = content.split(/\r?\n/);
  for (let i = 0; i < yamlLines.length; i++) {
    const raw = yamlLines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed.startsWith('- ')) continue;
    const indent = raw.length - raw.replace(/^[\t ]+/, '').length;
    const colonIdx = (() => {
      let inStr: string | null = null;
      for (let j = 0; j < raw.length; j++) {
        const ch = raw[j];
        if (inStr) { if (ch === inStr && raw[j - 1] !== '\\') inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === ':') return j;
      }
      return -1;
    })();
    if (colonIdx < 0) continue;
    const key = raw.slice(indent, colonIdx).trim();
    if (!key) continue;
    const after = raw.slice(colonIdx + 1).trim();
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const dotted = [...stack.map((s) => s.key), key].join('.');
    if (after === '' || after.startsWith('#')) {
      stack.push({ indent, key });
    } else {
      // 带内联值的叶节点（或流式映射如 `{ a: 1 }`——
      // 我们将其作为叶节点而非子树处理；对于 `@Value` 来说精度足够）。
      const valStripped = after.replace(/^["']|["']$/g, '');
      emitLeaf(dotted, i + 1, valStripped);
    }
  }
  return { nodes, references: [] };
}

/** 将 `safe`（已去除注释）中发现的 `@Value("${k}")` 和
 * `@ConfigurationProperties(prefix=...)` 引用追加到调用方的
 * `nodes`/`references` 数组中。 */
function extractSpringValueBindings(
  filePath: string,
  safe: string,
  lang: 'java' | 'kotlin',
  now: number,
  nodes: Node[],
  references: UnresolvedRef[],
): void {
  const valueRe = /@Value\s*\(\s*["']\$\{([^}:]+)(?::[^}]*)?\}["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = valueRe.exec(safe)) !== null) {
    const key = m[1]!.trim();
    if (!key) continue;
    const line = safe.slice(0, m.index).split('\n').length;
    const bindNode: Node = {
      id: `spring-value:${filePath}:${line}:${key}`,
      kind: 'constant',
      name: key,
      qualifiedName: `${filePath}::@Value:${key}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: m[0].length,
      language: lang,
      signature: `@Value("${key}")`,
      updatedAt: now,
    };
    nodes.push(bindNode);
    references.push({
      fromNodeId: bindNode.id,
      referenceName: key,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: lang,
    });
  }

  const cpRe = /@ConfigurationProperties\s*\(\s*(?:prefix\s*=\s*)?["']([^"']+)["']/g;
  while ((m = cpRe.exec(safe)) !== null) {
    const prefix = m[1]!.trim();
    if (!prefix) continue;
    const line = safe.slice(0, m.index).split('\n').length;
    const bindNode: Node = {
      id: `spring-cp:${filePath}:${line}:${prefix}`,
      kind: 'constant',
      name: prefix,
      qualifiedName: `${filePath}::@ConfigurationProperties:${prefix}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: m[0].length,
      language: lang,
      signature: `@ConfigurationProperties("${prefix}")`,
      updatedAt: now,
    };
    nodes.push(bindNode);
    references.push({
      fromNodeId: bindNode.id,
      // 用 `:prefix` 后缀标记引用，使 springResolver.resolve
      // 知道要将其展开为子树而非单个键。
      referenceName: `${prefix}:prefix`,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: lang,
    });
  }
}

/** Spring 的宽松绑定（`cache-list` ↔ `cacheList` ↔ `cache_list` ↔
 * `CACHE_LIST`）折叠为小写并去除连字符/下划线。我们以此规范形式
 * 比较候选键与引用键。 */
function canonicalConfigKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

// 目录模式
const SERVICE_DIRS = ['/service/', '/services/'];
const REPO_DIRS = ['/repository/', '/repositories/'];
const CONTROLLER_DIRS = ['/controller/', '/controllers/'];
const ENTITY_DIRS = ['/entity/', '/entities/', '/model/', '/models/', '/domain/'];
const COMPONENT_DIRS = ['/component/', '/components/', '/config/'];

const CLASS_KINDS = new Set(['class']);
const SERVICE_KINDS = new Set(['class', 'interface']);

/** 从映射参数中提取路径字符串（`"/x"`、`value = "/x"`、`path = "/x"`）；若为 BARE 则返回 ''。 */
function parseMappingPath(args: string): string {
  const m = args.match(/["']([^"']*)["']/);
  return m ? m[1]! : '';
}

/** 将类级别前缀和方法子路径拼接为一个规范化的 `/path`。 */
function joinPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

/**
 * 通过索引查询按名称解析符号，而非扫描所有文件。
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

  // 优先选取框架惯用目录中的候选项
  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // 回退到任意匹配项
  return kindFiltered[0]!.id;
}
