/**
 * 搜索查询工具集
 *
 * 用于搜索词提取与评分的共享模块。
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node } from '../types';

/** 将名称规范化为可比较的 token：转小写，仅保留字母和数字。 */
export function normalizeNameToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 代表整个项目名称的 token——来自 `go.mod` 模块名、`package.json`
 * name 字段或仓库根目录名——而非任何具体符号。用户自然会把项目名
 * 放进查询作为上下文（"MyApp backend routes"），但它不带任何区分
 * 性信号：当它同时是某个栈中某个符号或路径的子串时（如 `MyAppFrontend/`
 * 目录、`MyAppApp` 类），词法上会将该栈的权重放大，而埋没查询中的
 * 其余部分（#720）。
 *
 * 返回值已规范化（小写，仅含字母和数字），以便查询词可按规范化形式
 * 进行比较。只保留长度 ≥5 的名称——较短的名称（`api`、`app`、`core`、
 * `web`）与真实查询词冲突太频繁，不宜降权。
 */
export function deriveProjectNameTokens(projectRoot: string): Set<string> {
  const tokens = new Set<string>();
  const add = (raw: string | undefined | null): void => {
    if (!raw) return;
    const norm = normalizeNameToken(raw);
    if (norm.length >= 5) tokens.add(norm);
  };

  // go.mod 模块名末段（Go 仓库最可靠的信号）。
  try {
    const gomod = fs.readFileSync(path.join(projectRoot, 'go.mod'), 'utf-8');
    const m = gomod.match(/^\s*module\s+(\S+)/m);
    if (m && m[1]) add(m[1].split('/').pop());
  } catch { /* no go.mod */ }

  // package.json name 字段（去掉 `@scope/` 前缀）。
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    if (typeof pkg.name === 'string') add(pkg.name.replace(/^@[^/]+\//, ''));
  } catch { /* no / invalid package.json */ }

  // 仓库根目录名——两个清单文件都未命名项目时的兜底方案。
  add(path.basename(path.resolve(projectRoot)));

  return tokens;
}

/**
 * 从搜索查询中过滤掉的常见停用词。
 * 包含通用英文词 + 代码相关噪声词。
 */
export const STOP_WORDS = new Set([
  // 英文通用词
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'are', 'was',
  'be', 'has', 'had', 'have', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'not', 'no', 'all', 'each',
  'every', 'how', 'what', 'where', 'when', 'who', 'which', 'why',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'show', 'give', 'tell',
  'been', 'done', 'made', 'used', 'using', 'work', 'works', 'found',
  'also', 'into', 'then', 'than', 'just', 'more', 'some', 'such',
  'over', 'only', 'out', 'its', 'so', 'up', 'as', 'if',
  'look', 'need', 'needs', 'want', 'happen', 'happens',
  'affect', 'affected', 'break', 'breaks', 'failing',
  'implemented', 'implement',
  // 代码相关噪声词（避免过滤 get/set/add/build/find/list 等常见符号名）
  'code', 'file', 'files', 'function', 'method', 'class', 'type',
  'fix', 'bug', 'called',
]);

/**
 * 通过去除常见英文后缀来生成搜索词的词干变体。
 * 用于 FTS 查询扩展，使 "caching" 也能匹配 "cache"，"eviction" 也能匹配 "evict" 等。
 * 词干在 FTS 中用作前缀匹配，因此不需要是完整的英文单词。
 */
export function getStemVariants(term: string): string[] {
  const variants = new Set<string>();
  const t = term.toLowerCase();

  // -ing：caching→cach/cache，handling→handl/handle，running→run
  if (t.endsWith('ing') && t.length > 5) {
    const base = t.slice(0, -3);
    variants.add(base);
    variants.add(base + 'e');
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  // -tion/-sion：eviction→evict，expression→express
  if ((t.endsWith('tion') || t.endsWith('sion')) && t.length > 5) {
    variants.add(t.slice(0, -3));
  }

  // -ment：management→manage
  if (t.endsWith('ment') && t.length > 6) {
    variants.add(t.slice(0, -4));
  }

  // -ies：entries→entry
  if (t.endsWith('ies') && t.length > 4) {
    variants.add(t.slice(0, -3) + 'y');
  }
  // -es：processes→process，classes→class
  else if (t.endsWith('es') && t.length > 4) {
    variants.add(t.slice(0, -2));
  }
  // -s：errors→error（跳过 -ss 结尾，如 "class"）
  else if (t.endsWith('s') && !t.endsWith('ss') && t.length > 4) {
    variants.add(t.slice(0, -1));
  }

  // -ed：handled→handle，propagated→propagate，carried→carry
  if (t.endsWith('ed') && !t.endsWith('eed') && t.length > 4) {
    variants.add(t.slice(0, -1));
    variants.add(t.slice(0, -2));
    if (t.endsWith('ied') && t.length > 5) {
      variants.add(t.slice(0, -3) + 'y');
    }
  }

  // -er：builder→build/builde，handler→handl/handle，getter→get
  if (t.endsWith('er') && t.length > 4) {
    const base = t.slice(0, -2);
    variants.add(base);
    variants.add(base + 'e');
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  return [...variants].filter(v => v.length >= 3 && v !== t);
}

/**
 * 从自然语言查询中提取有意义的搜索词。
 * 在过滤前先将 camelCase、PascalCase、snake_case、SCREAMING_SNAKE
 * 和 dot.notation 拆分为独立 token。
 *
 * 在拆分结果的同时保留原始复合标识符（如 "scrapeLoop"），
 * 以便 FTS 既能匹配完整符号名，也能匹配其中的单个单词。
 *
 * 同时生成词干变体（如 "caching"→"cache"、"eviction"→"evict"），
 * 使 FTS 前缀匹配能找到相关代码符号。
 */
export function extractSearchTerms(query: string, options?: { stems?: boolean }): string[] {
  const includeStems = options?.stems !== false;
  const tokens = new Set<string>();

  // 先提取并保留复合标识符，再进行拆分
  // CamelCase：scrapeLoop、UserService、getCallGraph
  const compoundPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = compoundPattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      tokens.add(match[1].toLowerCase()); // 保留完整复合词："scrapeloop"
    }
  }

  // snake_case：scrape_loop、user_service
  const snakePattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b/g;
  while ((match = snakePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      tokens.add(match[1].toLowerCase());
    }
  }

  // 拆分 camelCase / PascalCase："getUserName" → "get User Name"
  const camelSplit = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // 将下划线和点替换为空格（snake_case、dot.notation）
  const normalised = camelSplit.replace(/[_.]+/g, ' ');

  // 按任意非字母数字字符拆分
  const words = normalised.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length < 3) continue;
    if (STOP_WORDS.has(lower)) continue;
    tokens.add(lower);
  }

  // 生成词干变体以扩大 FTS 匹配范围。
  // "caching" → "cache" 可找到 CacheBuilder；"eviction" → "evict" 可找到 evictEntries。
  // 同时通过将词项数量提升至 1 以上来实现共现抑制。
  // 在路径相关性评分时跳过词干（词干会虚高路径得分）。
  if (includeStems) {
    const stems = new Set<string>();
    for (const token of tokens) {
      for (const variant of getStemVariants(token)) {
        if (!tokens.has(variant) && !STOP_WORDS.has(variant)) {
          stems.add(variant);
        }
      }
    }
    for (const stem of stems) {
      tokens.add(stem);
    }
  }

  return [...tokens];
}

/**
 * 对路径与查询的相关性打分
 * 分数越高表示路径越相关
 */
export function scorePathRelevance(
  filePath: string,
  query: string,
  projectNameTokens?: Set<string>,
): number {
  const pathLower = filePath.toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  const dirName = path.dirname(filePath).toLowerCase();
  let score = 0;

  // 按原始查询的每个"词"打分，而非按每个子 token 打分。一个 PascalCase 单词
  // 会拆分出许多子 token（项目名 "SuperBizAgent" →
  // superbizagent / super / biz / agent），它们全部匹配同一个路径段，
  // 因此按子 token 求和会将该路径的得分放大 4 倍——足以将查询中其余
  // 路径栈埋没（#720）。一个词只要有任意子 token 匹配路径层级，
  // 就算匹配，且仅计一次；不同的词仍各自累加。
  // 将原始大小写查询拆分为词；extractSearchTerms 对每个词进行
  // camelCase/snake 拆分（这样 `getUserName` 仍能匹配 `get_user_name`
  // 路径）——只是把每个词的匹配归一次贡献。
  const allWords = query.split(/\s+/).filter((w) => w.length > 0);
  if (allWords.length === 0) return 0;

  // 仅命名了项目本身的查询词（其 go.mod / package.json / 仓库名）
  // 不带任何区分性路径信号——将其丢弃，让查询中其余词决定排名，
  // 而不是让 `<ProjectName>…/` 树下的每个文件仅凭项目名胜出（#720）。
  // 仅当还有其他词存在时才丢弃，以便纯项目名查询仍能按路径打分。
  const words =
    projectNameTokens && projectNameTokens.size > 0
      ? allWords.filter((w) => !projectNameTokens.has(normalizeNameToken(w)))
      : allWords;
  const scored = words.length > 0 ? words : allWords;

  for (const word of scored) {
    // 仅使用基础词——词干变体会生成大量近似重复词，全部匹配相同路径段，
    // 从而虚高路径得分。
    const subtokens = extractSearchTerms(word, { stems: false });
    if (subtokens.length === 0) continue;
    // 精确文件名匹配（最强）
    if (subtokens.some((t) => fileName.includes(t))) score += 10;
    // 目录匹配
    if (subtokens.some((t) => dirName.includes(t))) score += 5;
    // 通用路径匹配
    else if (subtokens.some((t) => pathLower.includes(t))) score += 3;
  }

  // 除非查询明确涉及测试，否则降低测试文件的优先级
  const queryLower = query.toLowerCase();
  const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
  if (!isTestQuery && isTestFile(filePath)) {
    score -= 15;
  }

  return score;
}

/**
 * 检查文件路径是否看起来像测试文件
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const fileName = path.basename(filePath);   // 原始大小写——camelCase 边界检测需要
  const lowerName = fileName.toLowerCase();

  // --- 文件名模式 ---
  if (
    lowerName.startsWith('test_') ||                              // python：test_foo.py
    lowerName.startsWith('test.') ||
    // 分隔符分隔：foo_test.go、foo.test.ts、foo-spec.rb、bar_spec.py
    /[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lowerName) ||
    // CamelCase 后缀（Java/Kotlin/Swift/C#/Scala）：FooTest.kt、BarTests.swift、
    // BazSpec.scala、QuxTestCase.java。首字母大写，以避免匹配 "latest.kt"/"manifest.kt"
    // （小写 "test"）。
    /(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$/.test(fileName)
  ) {
    return true;
  }

  // --- 目录模式 ---
  if (
    lower.includes('/tests/') || lower.includes('/test/') ||
    lower.includes('/__tests__/') || lower.includes('/spec/') ||
    lower.includes('/specs/') || lower.includes('/testlib/') ||
    lower.includes('/testing/') ||
    lower.startsWith('test/') || lower.startsWith('tests/') ||
    lower.startsWith('spec/') || lower.startsWith('specs/') ||
    // CamelCase 测试源集目录（Kotlin Multiplatform / Gradle / Xcode）：
    // jvmTest/、commonTest/、androidTest/、iosTest/、integrationTest/。首字母大写，
    // 以避免匹配 "latest/" / "manifest/"。
    /(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath)
  ) {
    return true;
  }

  // 非生产目录：examples、samples、benchmarks、fixtures、demos。
  // 同时检查路径中间（/integration/）和路径开头（integration/），
  // 因为文件路径可能以不带前导斜杠的相对路径存储。
  return matchesNonProductionDir(lower);
}

/**
 * 检查路径是否位于非生产目录中（integration、sample、example 等）。
 * 同时处理绝对路径（/foo/integration/bar）和相对路径（integration/bar）。
 */
function matchesNonProductionDir(lowerPath: string): boolean {
  const dirs = [
    'integration', 'sample', 'samples', 'example', 'examples',
    'fixture', 'fixtures', 'benchmark', 'benchmarks', 'demo', 'demos',
  ];
  for (const dir of dirs) {
    if (lowerPath.includes('/' + dir + '/') || lowerPath.startsWith(dir + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * 节点名称与搜索查询匹配时的加分。
 * 精确匹配加分最大；前缀匹配加分较小。
 * 多词查询还会对名称逐个检查词项匹配。
 */
export function nameMatchBonus(nodeName: string, query: string): number {
  const nameLower = nodeName.toLowerCase();

  // 将查询拆分为词级 token（处理 "CacheBuilder build" → ["cache","builder","build"]）
  const rawTerms = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_.\-]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2);

  // 同时保留原始空格分隔的 token 用于精确词项匹配
  const queryTokens = query.split(/\s+/).map(t => t.toLowerCase()).filter(t => t.length >= 2);

  // 完整查询作为单一 token（用于 "CacheBuilder" 这样的复合标识符）
  const queryLower = query.replace(/[\s]+/g, '').toLowerCase();

  // 精确匹配：查询与节点名称完全一致
  if (nameLower === queryLower) return 80;

  // 查询 token 精确匹配："CacheBuilder build" 且节点名称为 "build"
  if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return 60;

  // 名称以查询开头——按长度比例缩放，使 "Pod"→"Pod"（精确，已在上方处理）
  // 的得分远高于 "Pod"→"PodGCControllerOptions"（比例 0.125）。
  if (nameLower.startsWith(queryLower)) {
    const ratio = queryLower.length / nameLower.length;
    return Math.round(10 + 30 * ratio);
  }

  // camelCase 拆分后的所有词项都出现在名称中
  if (rawTerms.length > 1) {
    const allMatch = rawTerms.every(t => nameLower.includes(t));
    if (allMatch) return 15;
  }

  // 名称包含完整查询作为子串
  if (nameLower.includes(queryLower)) return 10;

  return 0;
}

/**
 * 基于节点类型的搜索排名加分
 * 函数和类通常比变量/导入更相关
 */
export function kindBonus(kind: Node['kind']): number {
  const bonuses: Record<string, number> = {
    function: 10,
    method: 10,
    class: 8,
    interface: 9,
    type_alias: 6,
    struct: 6,
    trait: 9,
    enum: 5,
    component: 8,
    route: 9,
    module: 4,
    property: 3,
    field: 3,
    variable: 2,
    constant: 3,
    import: 1,
    export: 1,
    parameter: 0,
    namespace: 4,
    file: 0,
    protocol: 9,
    enum_member: 3,
  };
  return bonuses[kind] ?? 0;
}

/**
 * 判断一个查询 token 是否看起来像用户刻意输入的代码标识符
 * （camelCase / 内部含大写的 PascalCase / snake_case / 含数字），
 * 而非普通英文词（"flat"、"object"、"screen"）。
 *
 * 用于决定精确名称匹配是否应获得"用户命名了此符号"的豁免，
 * 使其不受单词项抑制。一个恰好精确匹配到无关符号的普通英文词——
 * 例如查询 "flat object" 匹配到名为 `FLAT` 的常量——
 * 绝不能获得该豁免，否则 +exact-name 加分会在散文查询中将其浮到顶部。
 *
 * 按用户输入的原始 token 分类，而非匹配符号的名称：
 * "flat"（小写、描述性）即便匹配到 `FLAT` 也是非区分性的。
 * 首字母大写的单词（"Screen"、"Zustand"）也被视为普通词——
 * 句首大写和专有名词不是可靠的标识符信号。
 */
export function isDistinctiveIdentifier(token: string): boolean {
  if (!token) return false;
  // snake_case / SCREAMING_SNAKE，或含嵌入数字 → 刻意使用的标识符。
  if (/[_0-9]/.test(token)) return true;
  // 第一个字符之后有大写字母 → camelCase/PascalCase 边界
  // （setLastEmail、OrgUserStore）或缩写词（REST、HTTP）。
  if (/[A-Z]/.test(token.slice(1))) return true;
  return false;
}
