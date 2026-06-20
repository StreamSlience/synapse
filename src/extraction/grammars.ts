/**
 * grammar 加载与缓存
 *
 * 使用 web-tree-sitter（WASM）实现通用跨平台支持。
 * grammar 按需懒加载——仅编译项目中实际出现的语言，
 * 从而降低大型代码库中 V8 WASM 的内存压力。
 */

import * as path from 'path';
import { Parser, Language as WasmLanguage } from 'web-tree-sitter';
import { Language } from '../types';

export type GrammarLanguage = Exclude<Language, 'svelte' | 'vue' | 'astro' | 'liquid' | 'razor' | 'yaml' | 'twig' | 'xml' | 'properties' | 'unknown'>;

/**
 * WASM 文件名映射——将每种语言映射到 tree-sitter-wasms 包中对应的 .wasm grammar 文件。
 */
const WASM_GRAMMAR_FILES: Record<GrammarLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  php: 'tree-sitter-php.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  dart: 'tree-sitter-dart.wasm',
  pascal: 'tree-sitter-pascal.wasm',
  scala: 'tree-sitter-scala.wasm',
  lua: 'tree-sitter-lua.wasm',
  r: 'tree-sitter-r.wasm',
  luau: 'tree-sitter-luau.wasm',
  objc: 'tree-sitter-objc.wasm',
};

/**
 * 文件扩展名到语言的映射
 */
export const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  // ESM/CJS TypeScript 模块扩展名——按 TS 解析（无 JSX）。(#366)
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // SAP HANA XS Classic 服务端 JavaScript。(#556)
  '.xsjs': 'javascript',
  '.xsjslib': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c', // 也可能是 C++，默认按 C 处理
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  // ASP.NET Razor / Blazor 标记——使用自定义 RazorExtractor（将 @model/@inject/
  // 组件标签链接到对应的 C# 类型；标记本身没有 tree-sitter grammar）。
  '.cshtml': 'razor',
  '.razor': 'razor',
  '.php': 'php',
  // Drupal 专用 PHP 文件扩展名
  '.module': 'php',
  '.install': 'php',
  '.theme': 'php',
  '.inc': 'php',
  // YAML（用于 Drupal 路由文件；不提取符号，仅做文件级追踪）
  '.yml': 'yaml',
  '.yaml': 'yaml',
  // Twig 模板（仅做文件级追踪，不提取符号）
  '.twig': 'twig',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.dart': 'dart',
  '.liquid': 'liquid',
  '.svelte': 'svelte',
  '.vue': 'vue',
  '.astro': 'astro',
  '.r': 'r',
  '.pas': 'pascal',
  '.dpr': 'pascal',
  '.dpk': 'pascal',
  '.lpr': 'pascal',
  '.dfm': 'pascal',
  '.fmx': 'pascal',
  '.scala': 'scala',
  '.sc': 'scala',
  '.lua': 'lua',
  '.luau': 'luau',
  '.m': 'objc',
  '.mm': 'objc',
  // XML：文件级追踪；MyBatis 提取器匹配 `<mapper namespace="...">` 结构
  // 并生成 SQL 语句节点（其他 XML 返回空结果）。
  '.xml': 'xml',
  // Spring 配置：`application.properties` / `application-*.properties`。与
  // `.yml` 变体结构相同——YAML/properties 提取器为每个叶键生成一个节点，
  // Spring 解析器将 `@Value("${k}")` 引用与之关联。
  '.properties': 'properties',
};

/**
 * 根据文件扩展名判断 Synapse 是否能解析该文件。
 * 这是"是否应索引此文件"的唯一真实来源——派生自 EXTENSION_MAP，
 * 确保解析器支持与索引选择永不偏离。
 */
export function isSourceFile(filePath: string): boolean {
  if (isPlayRoutesFile(filePath)) return true; // Play `conf/routes` is extensionless
  if (isShopifyLiquidJson(filePath)) return true; // Shopify OS 2.0 JSON templates / section groups
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  return filePath.slice(dot).toLowerCase() in EXTENSION_MAP;
}

/**
 * Shopify OS 2.0 JSON 模板（`templates/*.json`）或节（section）组
 * （`sections/*.json`）——这些文件通过 `"type"` 引用节，因此 Liquid
 * 提取器会将它们关联起来。（config/ + locales/ 下的 JSON 不包含节引用。）
 */
export function isShopifyLiquidJson(filePath: string): boolean {
  // 允许嵌套的模板目录（`templates/customers/login.json`），而不仅仅是
  // 顶层目录（`templates/product.json`）。
  return /(^|\/)(templates|sections)\/.+\.json$/i.test(filePath);
}

/**
 * Play Framework 路由文件：无扩展名的 `conf/routes`（以及包含的
 * `conf/*.routes`）。没有 grammar——路由提取由 Play 框架解析器完成，
 * 因此通过无 grammar（`yaml` 风格）路径处理。
 */
export function isPlayRoutesFile(filePath: string): boolean {
  return (
    filePath === 'conf/routes' ||
    filePath.endsWith('/conf/routes') ||
    filePath.endsWith('.routes')
  );
}

/**
 * 已加载 grammar 和 parser 的缓存
 */
const parserCache = new Map<Language, Parser>();
const languageCache = new Map<Language, WasmLanguage>();
const unavailableGrammarErrors = new Map<Language, string>();

let parserInitialized = false;

/**
 * 初始化 tree-sitter WASM 运行时。必须在加载 grammar 之前调用。
 * 不加载任何 grammar WASM 文件——请使用 loadGrammarsForLanguages() 完成该步骤。
 * 幂等——可安全多次调用。
 */
export async function initGrammars(): Promise<void> {
  if (parserInitialized) return;

  await Parser.init();

  parserInitialized = true;
}

/**
 * 仅为指定语言加载 grammar WASM 文件。
 * 跳过已加载或没有 WASM grammar 的语言。
 * 必须在 initGrammars() 之后调用。
 */
export async function loadGrammarsForLanguages(languages: Language[]): Promise<void> {
  if (!parserInitialized) {
    await initGrammars();
  }

  // SFC 语言（svelte/vue/astro）没有自己的 grammar——它们的提取器
  // 将 <script>/frontmatter 内容委托给 TS/JS 提取器，因此即使索引集中
  // 没有普通的 .ts/.js 文件（例如纯 .astro 内容站），也必须加载这些 grammar。
  if (languages.some((l) => l === 'svelte' || l === 'vue' || l === 'astro')) {
    languages = [...languages, 'typescript', 'javascript'];
  }

  // 去重并过滤：保留有 WASM grammar 且尚未加载的语言
  const toLoad = [...new Set(languages)].filter(
    (lang): lang is GrammarLanguage =>
      lang in WASM_GRAMMAR_FILES &&
      !languageCache.has(lang) &&
      !unavailableGrammarErrors.has(lang)
  );

  // 顺序加载 grammar，避免 Node 20+ 上 web-tree-sitter WASM 的竞争条件
  // 参见：https://github.com/tree-sitter/tree-sitter/issues/2338
  for (const lang of toLoad) {
    const wasmFile = WASM_GRAMMAR_FILES[lang];
    try {
      // 部分 grammar 附带自己的 WASM（不在 tree-sitter-wasms 中，或
      // tree-sitter-wasms 的构建版本过旧）。Lua：tree-sitter-wasms 附带的
      // ABI-13 构建在 web-tree-sitter 0.25 下会损坏共享 WASM 堆（在第一个
      // 文件之后每个文件都丢失嵌套调用/导入）；我们改用上游 ABI-15 wasm。
      // C#：tree-sitter-wasms 的构建（ABI 13）不支持主构造函数，会将
      // `class Foo(...)` 解析为吞掉整个类的 ERROR（#237）；我们改用上游
      // ABI-15 的 tree-sitter-c-sharp 0.23.5 wasm，它原生支持主构造函数。
      const wasmPath = (lang === 'pascal' || lang === 'scala' || lang === 'lua' || lang === 'luau' || lang === 'csharp' || lang === 'r')
        ? path.join(__dirname, 'wasm', wasmFile)
        : require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
      const language = await WasmLanguage.load(wasmPath);
      languageCache.set(lang, language);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Synapse] Failed to load ${lang} grammar — parsing will be unavailable: ${message}`);
      unavailableGrammarErrors.set(lang, message);
    }
  }
}

/**
 * 加载所有 grammar WASM 文件。供测试和向后兼容使用的便捷函数。
 * 生产环境中推荐使用 loadGrammarsForLanguages()。
 */
export async function loadAllGrammars(): Promise<void> {
  const allLanguages = Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[];
  await loadGrammarsForLanguages(allLanguages);
}

/**
 * 检查 grammar 是否已初始化
 */
export function isGrammarsInitialized(): boolean {
  return parserInitialized;
}

/**
 * 获取指定语言的 parser。
 * 从预加载缓存中同步返回。
 */
export function getParser(language: Language): Parser | null {
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  const lang = languageCache.get(language);
  if (!lang) {
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(language, parser);
  return parser;
}

/**
 * 从文件扩展名检测语言
 */
export function detectLanguage(filePath: string, source?: string): Language {
  // Play 的 `conf/routes` 没有 grammar——走无符号路径；
  // Play 框架解析器从中提取路由节点。
  if (isPlayRoutesFile(filePath)) return 'yaml';
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  // Shopify OS 2.0 JSON 模板 / 节组 → Liquid 提取器（将每个节的 `"type"` 关联到对应的 `sections/<type>.liquid`）。
  if (isShopifyLiquidJson(filePath)) return 'liquid';
  const lang = EXTENSION_MAP[ext] || 'unknown';

  // .h 文件可能是 C、C++ 或 Objective-C——检查源码内容
  if (lang === 'c' && ext === '.h' && source) {
    if (looksLikeCpp(source)) return 'cpp';
    if (looksLikeObjc(source)) return 'objc';
  }

  return lang;
}

/**
 * 启发式判断：.h 文件是否包含 C++ 构造？
 * 检查前约 8KB，寻找仅在 C++ 中合法而在 C 中从不合法的模式。
 */
function looksLikeCpp(source: string): boolean {
  const sample = source.substring(0, 8192);
  return /\bnamespace\b|\bclass\s+\w+\s*[:{]|\btemplate\s*<|\b(?:public|private|protected)\s*:|\bvirtual\b|\busing\s+(?:namespace\b|\w+\s*=)/.test(sample);
}

/**
 * 启发式判断：.h 文件是否包含 Objective-C 构造？
 */
function looksLikeObjc(source: string): boolean {
  const sample = source.substring(0, 8192);
  return /@(?:interface|implementation|protocol|synthesize)\b/.test(sample);
}

/**
 * 检查某语言是否受支持（已定义对应 grammar）。
 * 即使尚未加载，只要 grammar 存在也返回 true。
 */
export function isLanguageSupported(language: Language): boolean {
  if (language === 'svelte') return true; // 自定义提取器（script 块委托）
  if (language === 'vue') return true; // 自定义提取器（script 块委托）
  if (language === 'astro') return true; // 自定义提取器（frontmatter/script 块委托）
  if (language === 'liquid') return true; // 自定义正则提取器
  if (language === 'razor') return true; // 自定义 RazorExtractor（.cshtml/.razor 标记）
  if (language === 'yaml') return true; // 仅文件级追踪；通过框架解析器进行 Drupal 路由提取
  if (language === 'twig') return true; // 仅文件级追踪
  if (language === 'xml') return true; // MyBatis mapper 提取器
  if (language === 'properties') return true; // Spring 配置键
  if (language === 'unknown') return false;
  return language in WASM_GRAMMAR_FILES;
}

/**
 * 检查某语言的 grammar 是否已加载并可用于解析。
 */
export function isGrammarLoaded(language: Language): boolean {
  if (language === 'svelte' || language === 'vue' || language === 'astro' || language === 'liquid' || language === 'razor') return true;
  if (language === 'yaml' || language === 'twig') return true; // 无需 WASM grammar
  if (language === 'xml' || language === 'properties') return true; // 无需 WASM grammar
  return languageCache.has(language);
}

/**
 * 仅在文件记录级别追踪的语言：解析不生成任何符号节点，但文件仍会被存储
 * （框架解析器之后可能添加文件级引用，例如 Drupal 路由 yml、Spring
 * `@Value` 对应 application.properties）。这是 `tree-sitter.ts` 中无符号
 * 分支的权威集合；`xml` 故意排除在外，因为其 MyBatis 提取器会生成文件节点。
 * 调用方使用此函数将这类文件计为"已索引"而非"已跳过"，因此必须与该分支保持同步。
 */
export function isFileLevelOnlyLanguage(language: Language): boolean {
  return language === 'yaml' || language === 'twig' || language === 'properties';
}

/**
 * 获取所有受支持的语言（已定义 grammar 的语言）。
 */
export function getSupportedLanguages(): Language[] {
  return [...(Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[]), 'svelte', 'vue', 'astro', 'liquid'];
}

/**
 * 重置某语言的缓存 parser 以回收 WASM 堆内存。
 * tree-sitter WASM 运行时在数千次解析后会积累碎片内存。删除并重新创建
 * Parser 实例会强制重置 WASM 堆，防止大型代码库中出现
 * "memory access out of bounds" 崩溃。
 */
export function resetParser(language: Language): void {
  const old = parserCache.get(language);
  if (old) {
    old.delete();
    parserCache.delete(language);
  }
}

/**
 * 清除 parser/grammar 缓存（供测试使用）
 */
export function clearParserCache(): void {
  for (const parser of parserCache.values()) {
    parser.delete();
  }
  parserCache.clear();
  // 注意：languageCache 不会被清除——WASM 语言会持久存在。
  // 若需完全重新初始化，将 parserInitialized 设为 false 并重新调用 initGrammars()。
  unavailableGrammarErrors.clear();
}

/**
 * 报告加载失败的 grammar。
 */
export function getUnavailableGrammarErrors(): Partial<Record<Language, string>> {
  const out: Partial<Record<Language, string>> = {};
  for (const [language, message] of unavailableGrammarErrors.entries()) {
    out[language] = message;
  }
  return out;
}

/**
 * 获取语言的显示名称
 */
export function getLanguageDisplayName(language: Language): string {
  const names: Record<Language, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    tsx: 'TypeScript (TSX)',
    jsx: 'JavaScript (JSX)',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
    r: 'R',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    razor: 'Razor/Blazor',
    php: 'PHP',
    ruby: 'Ruby',
    swift: 'Swift',
    kotlin: 'Kotlin',
    dart: 'Dart',
    svelte: 'Svelte',
    vue: 'Vue',
    astro: 'Astro',
    liquid: 'Liquid',
    pascal: 'Pascal / Delphi',
    scala: 'Scala',
    lua: 'Lua',
    luau: 'Luau',
    objc: 'Objective-C',
    yaml: 'YAML',
    twig: 'Twig',
    xml: 'XML',
    properties: 'Java properties',
    unknown: 'Unknown',
  };
  return names[language] || language;
}
