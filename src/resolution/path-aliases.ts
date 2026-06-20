/**
 * 项目级导入路径别名加载。
 *
 * 从项目根目录的 `tsconfig.json` / `jsconfig.json` 中读取
 * `compilerOptions.paths`，并将其模式转换为导入解析器可以查询的形式。
 *
 * 这是在现代 JS/TypeScript 代码库上实现精确解析的最大障碍：
 * 类似 `@/components/Foo`（Next、Nuxt、Nest、Vite 脚手架）这样的别名
 * 指向 `paths` 映射，而解析器此前会忽略该映射——所有通过别名的导入
 * 都被视为无法解析，除非恰好命中小范围的硬编码回退列表。
 *
 * v1 范围刻意保持精简：
 *   - 依次读取 tsconfig.json，再读 jsconfig.json
 *   - 遵循顶层的 `compilerOptions.baseUrl` 与 `compilerOptions.paths`
 *   - 支持 `*` 通配符（TypeScript 唯一支持的通配符）
 *   - 暂不跟随 `extends` 链（大多数项目不需要）
 *   - 暂不读取 Vite/webpack/Rollup 配置（后续单独跟进）
 *
 * 文件以容忍 JSON-with-comments 的方式解析——现实中的 tsconfig
 * 经常包含 `//` 和 `/* *\/` 注释以及尾随逗号，这些会导致 JSON.parse 报错。
 * 我们在解析前先将其剥离。
 */

import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';

/** 来自 `compilerOptions.paths` 的单个别名模式。 */
export interface AliasPattern {
  /** `*` 之前的字面前缀（若无 `*` 则为完整模式）。 */
  prefix: string;
  /** `*` 之后的字面后缀（几乎总是空字符串）。 */
  suffix: string;
  /** 该模式是否包含 `*` 通配符。 */
  hasWildcard: boolean;
  /**
   * 替换模板。当 `hasWildcard` 为 true 时，替换中的 `*` 会被
   * 导入路径中捕获的通配符部分填充。
   * 存储为相对于 {@link AliasMap.baseUrl} 的路径。
   * tsconfig 允许每个别名有多个目标（按优先级排序）。
   */
  replacements: string[];
}

export interface AliasMap {
  /** 绝对路径。`compilerOptions.paths` 的根目录。 */
  baseUrl: string;
  /**
   * 按特异性排序的模式：前缀越长越优先，同等前缀长度时字面模式优先于
   * 通配符模式，以确保解析器优先尝试最精确的匹配。
   */
  patterns: AliasPattern[];
}

/**
 * 剥离 JSONC 注释与尾随逗号，使带有常见 VS Code 风格注解的 tsconfig
 * 能够干净地解析。以微型状态机遍历源码，追踪字符串上下文——
 * 此前仅用 regex 的版本会破坏字符串值中的 URL
 * （`"baseUrl": "https://cdn.example.com"` 中 `//` 之后的内容会被截断）。
 */
function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // `}` 或 `]` 前的尾随逗号——在字符串之外，可安全地
  // 对剥离注释后的输出执行替换。
  return out.replace(/,(\s*[}\]])/g, '$1');
}

interface RawTsconfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

function readTsconfigLike(filePath: string): RawTsconfig | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(stripJsonc(raw)) as RawTsconfig;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    logDebug('path-aliases: failed to parse', { filePath, err: String(err) });
    return null;
  }
}

function splitWildcard(pattern: string): {
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
} {
  const star = pattern.indexOf('*');
  if (star === -1) return { prefix: pattern, suffix: '', hasWildcard: false };
  return {
    prefix: pattern.slice(0, star),
    suffix: pattern.slice(star + 1),
    hasWildcard: true,
  };
}

/**
 * 加载 `projectRoot` 的别名。当不存在 tsconfig / jsconfig，
 * 或文件中没有可用的 `paths` 时返回 `null`。
 *
 * 可频繁调用，开销极低——缓存由调用方负责
 * （解析器通过 {@link aliasCache} 实现缓存）。
 */
export function loadProjectAliases(projectRoot: string): AliasMap | null {
  const candidates = ['tsconfig.json', 'jsconfig.json'];
  let raw: RawTsconfig | null = null;
  let usedFile: string | null = null;
  for (const name of candidates) {
    const p = path.join(projectRoot, name);
    if (fs.existsSync(p)) {
      raw = readTsconfigLike(p);
      if (raw) {
        usedFile = name;
        break;
      }
    }
  }
  if (!raw) return null;

  const co = raw.compilerOptions ?? {};
  const baseUrlRel = co.baseUrl ?? '.';
  const baseUrl = path.resolve(projectRoot, baseUrlRel);

  const paths = co.paths;
  if (!paths || typeof paths !== 'object') {
    // 单独的 baseUrl 本身算不上"别名"；没有 paths 时我们只是在
    // 重定向整个目录树。跳过——现有解析器已能处理相对导入。
    return null;
  }

  const patterns: AliasPattern[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const filtered = targets.filter((t): t is string => typeof t === 'string');
    if (filtered.length === 0) continue;
    const { prefix, suffix, hasWildcard } = splitWildcard(pattern);
    patterns.push({ prefix, suffix, hasWildcard, replacements: filtered });
  }

  if (patterns.length === 0) return null;

  // 特异性排序：前缀越长越靠前；相同前缀长度时字面模式优先于
  // 通配符模式。TypeScript 本身采用类似的"最精确匹配优先"规则。
  patterns.sort((a, b) => {
    if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length;
    if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
    return 0;
  });

  logDebug('path-aliases loaded', {
    file: usedFile,
    baseUrl,
    patternCount: patterns.length,
  });

  return { baseUrl, patterns };
}

/**
 * 通过 {@link AliasMap} 解析导入路径。返回候选文件系统路径列表
 * （相对于 `projectRoot`），顺序遵循 tsconfig 定义的优先级
 * （每个别名的多个替换目标按顺序逐一尝试）。
 * 无别名匹配时返回 `[]`。
 *
 * 调用方仍需用语言的扩展名列表逐一尝试每个候选路径——
 * 本函数仅执行别名改写。
 */
export function applyAliases(
  importPath: string,
  aliases: AliasMap,
  projectRoot: string
): string[] {
  for (const pat of aliases.patterns) {
    if (!importPath.startsWith(pat.prefix)) continue;
    if (pat.suffix && !importPath.endsWith(pat.suffix)) continue;

    let captured = '';
    if (pat.hasWildcard) {
      captured = importPath.slice(pat.prefix.length, importPath.length - pat.suffix.length);
    } else if (importPath !== pat.prefix) {
      // 字面模式必须精确匹配。
      continue;
    }

    const out: string[] = [];
    for (const target of pat.replacements) {
      const filled = pat.hasWildcard ? target.replace('*', captured) : target;
      // baseUrl 为绝对路径；生成相对于 projectRoot 的路径
      const absolute = path.resolve(aliases.baseUrl, filled);
      const relative = path.relative(projectRoot, absolute);
      // 若改写结果逃逸出项目根目录则跳过（不安全，且无法通过文件索引查找）。
      if (relative.startsWith('..')) continue;
      out.push(relative.replace(/\\/g, '/'));
    }
    return out;
  }
  return [];
}
