/**
 * 导入解析器
 *
 * 将导入路径解析为实际文件和符号。
 */

import * as fs from 'fs';
import * as path from 'path';
import { Language, Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext, ImportMapping, ReExport } from './types';
import { applyAliases } from './path-aliases';
import { resolveWorkspaceImport } from './workspace-packages';

/**
 * 各语言的扩展名解析顺序
 */
const EXTENSION_RESOLUTION: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '/index.js', '/index.jsx'],
  tsx: ['.tsx', '.ts', '.d.ts', '.js', '.jsx', '/index.tsx', '/index.ts', '/index.js'],
  jsx: ['.jsx', '.js', '/index.jsx', '/index.js'],
  // SFC 消费者导入普通 TS/JS、同级组件以及桶文件
  // （`./lib` → `./lib/index.ts`）。若无此列表，来自
  // `.svelte`/`.vue` 文件的相对导入将解析为空，导致桶调用者消失（#629）。
  svelte: ['.ts', '.js', '.svelte', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.svelte'],
  vue: ['.ts', '.js', '.vue', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.vue'],
  astro: ['.ts', '.js', '.astro', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.astro'],
  python: ['.py', '/__init__.py'],
  go: ['.go'],
  rust: ['.rs', '/mod.rs'],
  java: ['.java'],
  c: ['.h', '.c'],
  cpp: ['.h', '.hpp', '.hxx', '.cpp', '.cc', '.cxx'],
  csharp: ['.cs'],
  php: ['.php'],
  ruby: ['.rb'],
  objc: ['.h', '.m', '.mm'],
};

/**
 * 将导入路径解析为实际文件
 */
export function resolveImportPath(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string | null {
  // 跳过外部/npm 包——但传入 context 以便裸说明符启发式
  // 可以先查阅项目的 tsconfig 别名映射（自定义前缀如 `@components/*`
  // 否则会被误判为 npm 包）。
  if (isExternalImport(importPath, language, context)) {
    return null;
  }

  const projectRoot = context.getProjectRoot();
  const fromDir = path.dirname(path.join(projectRoot, fromFile));

  // 处理相对导入
  if (importPath.startsWith('.')) {
    return resolveRelativeImport(importPath, fromDir, language, context);
  }

  // 处理绝对/别名导入（如 @/ 或 src/）
  const aliased = resolveAliasedImport(importPath, projectRoot, language, context);
  if (aliased) return aliased;

  // C/C++ 头文件目录搜索：当相对解析和别名解析均未找到匹配时，
  // 从 compile_commands.json 或启发式探测中搜索 -I 目录。
  if (language === 'c' || language === 'cpp') {
    return resolveCppIncludePath(importPath, language, context);
  }

  return null;
}

/**
 * C 和 C++ 标准库头文件名（不含分隔符）。
 * 供 isExternalImport 过滤系统级 include，不对其进行解析。
 */
const C_CPP_STDLIB_HEADERS = new Set([
  // C 标准库头文件
  'assert.h', 'complex.h', 'ctype.h', 'errno.h', 'fenv.h', 'float.h',
  'inttypes.h', 'iso646.h', 'limits.h', 'locale.h', 'math.h', 'setjmp.h',
  'signal.h', 'stdalign.h', 'stdarg.h', 'stdatomic.h', 'stdbool.h',
  'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'stdnoreturn.h',
  'string.h', 'tgmath.h', 'threads.h', 'time.h', 'uchar.h', 'wchar.h',
  'wctype.h',
  // C++ 对 C 库的包装头文件（cname 形式）
  'cassert', 'ccomplex', 'cctype', 'cerrno', 'cfenv', 'cfloat',
  'cinttypes', 'ciso646', 'climits', 'clocale', 'cmath', 'csetjmp',
  'csignal', 'cstdalign', 'cstdarg', 'cstdbool', 'cstddef', 'cstdint',
  'cstdio', 'cstdlib', 'cstring', 'ctgmath', 'ctime', 'cuchar',
  'cwchar', 'cwctype',
  // C++ STL 头文件
  'algorithm', 'any', 'array', 'atomic', 'barrier', 'bit', 'bitset',
  'charconv', 'chrono', 'codecvt', 'compare', 'complex', 'concepts',
  'condition_variable', 'coroutine', 'deque', 'exception', 'execution',
  'expected', 'filesystem', 'format', 'forward_list', 'fstream',
  'functional', 'future', 'generator', 'initializer_list', 'iomanip',
  'ios', 'iosfwd', 'iostream', 'istream', 'iterator', 'latch',
  'limits', 'list', 'locale', 'map', 'mdspan', 'memory', 'memory_resource',
  'mutex', 'new', 'numbers', 'numeric', 'optional', 'ostream', 'print',
  'queue', 'random', 'ranges', 'ratio', 'regex', 'scoped_allocator',
  'semaphore', 'set', 'shared_mutex', 'source_location', 'span',
  'spanstream', 'sstream', 'stack', 'stacktrace', 'stdexcept',
  'stdfloat', 'stop_token', 'streambuf', 'string', 'string_view',
  'strstream', 'syncstream', 'system_error', 'thread', 'tuple',
  'type_traits', 'typeindex', 'typeinfo', 'unordered_map',
  'unordered_set', 'utility', 'valarray', 'variant', 'vector',
  'version',
]);

/**
 * 判断一个导入是否为外部导入（npm 包等）
 *
 * `context` 用于查询项目定义的路径别名
 * （tsconfig/jsconfig `paths`）。若缺少此检查，自定义前缀
 * 如 `@components/*` 会在别名解析介入之前就被裸说明符启发式
 * 误判为外部导入。
 */
function isExternalImport(
  importPath: string,
  language: Language,
  context?: ResolutionContext
): boolean {
  // 相对导入不是外部导入
  if (importPath.startsWith('.')) {
    return false;
  }

  // 工作区成员导入（`@scope/ui`、`@scope/ui/widgets`）在 monorepo 中属于本地包，
  // 即便外观与裸 npm 说明符相同。先查阅工作区映射，避免误判为外部导入（#629）。
  // 单包仓库的映射为 null，此处为空操作。
  const workspaces = context?.getWorkspacePackages?.();
  if (workspaces && resolveWorkspaceImport(importPath, workspaces)) {
    return false;
  }

  // 常见外部模式
  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx') {
    // Node 内置模块
    if (['fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'events', 'stream', 'child_process', 'buffer'].includes(importPath)) {
      return true;
    }
    // 项目定义的别名前缀？视为本地导入。
    const aliases = context?.getProjectAliases?.();
    if (aliases) {
      for (const pat of aliases.patterns) {
        if (importPath.startsWith(pat.prefix)) return false;
      }
    }
    // 作用域包或不以别名开头的裸说明符
    if (!importPath.startsWith('@/') && !importPath.startsWith('~/') && !importPath.startsWith('src/')) {
      // 可能是 npm 包
      return true;
    }
  }

  if (language === 'python') {
    // 标准库模块
    const stdLibs = ['os', 'sys', 'json', 're', 'math', 'datetime', 'collections', 'typing', 'pathlib', 'logging'];
    if (stdLibs.includes(importPath.split('.')[0]!)) {
      return true;
    }
  }

  if (language === 'go') {
    // 相对导入（在惯用 Go 中很少见，但语法允许）。
    if (importPath.startsWith('.')) {
      return false;
    }
    // 模块内导入形如 `<module-path>/sub/pkg`，属于本地包。
    // 若不检查模块路径，Go monorepo 中的每个跨包调用
    // 都会被误判为外部导入（issue #388）。
    const mod = context?.getGoModule?.();
    if (mod && (importPath === mod.modulePath || importPath.startsWith(mod.modulePath + '/'))) {
      return false;
    }
    // 即使缺少 go.mod，`internal/` 包也保持本地——
    // 为没有解析到模块路径的仓库保留 #388 之前的兜底逻辑。
    if (importPath.includes('/internal/')) {
      return false;
    }
    // 其余均为 Go 标准库或第三方模块。
    return true;
  }

  if (language === 'c' || language === 'cpp') {
    // C/C++ 标准库头文件——包括 C 风格（<stdio.h>）和
    // C++ 风格（<cstdio>、<vector>）两种形式。与导入路径比对
    // （提取器已去掉 <> 或 "" 分隔符）。
    if (C_CPP_STDLIB_HEADERS.has(importPath)) return true;
    // C++ 无 .h 扩展名的头文件（如 "vector"、"string"）
    const withoutExt = importPath.replace(/\.h$/, '');
    if (C_CPP_STDLIB_HEADERS.has(withoutExt)) return true;
  }

  return false;
}

/**
 * 解析相对导入
 */
function resolveRelativeImport(
  importPath: string,
  fromDir: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const projectRoot = context.getProjectRoot();
  const extensions = EXTENSION_RESOLUTION[language] || [];

  // Python 点号相对导入（`from .certs import x`、`from ..pkg.mod import y`）：
  // 前导点号表示包层级（1 = 当前包），其余部分是带点的子模块路径。
  // `path.resolve(dir, '.certs')` 会将 `.certs` 视为字面隐藏文件名，
  // 因此在解析前需将 Python 形式转换为真实的文件系统相对路径。
  if (language === 'python' && importPath.startsWith('.')) {
    const dots = importPath.length - importPath.replace(/^\.+/, '').length;
    const up = '../'.repeat(Math.max(0, dots - 1));    // 1 个点 = 当前目录
    const rest = importPath.slice(dots).replace(/\./g, '/'); // 'sub.mod' -> 'sub/mod'
    const pyBase = path.resolve(fromDir, up + rest);
    const pyRel = path.relative(projectRoot, pyBase).replace(/\\/g, '/');
    for (const ext of extensions) {
      if (context.fileExists(pyRel + ext)) return pyRel + ext;
    }
    if (pyRel && context.fileExists(pyRel)) return pyRel;
    return null;
  }

  // 先尝试原始路径
  const basePath = path.resolve(fromDir, importPath);
  const relativePath = path.relative(projectRoot, basePath).replace(/\\/g, '/');

  // 逐一尝试各扩展名
  for (const ext of extensions) {
    const candidatePath = relativePath + ext;
    if (context.fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  // 不带扩展名尝试（路径本身可能已含扩展名）
  if (context.fileExists(relativePath)) {
    return relativePath;
  }

  return null;
}

/**
 * 解析别名/绝对导入。
 *
 * 按顺序尝试以下三步策略：
 *   1. 项目定义的 `compilerOptions.paths`（tsconfig/jsconfig）。
 *      每个模式可有多个替换目标；按 tsconfig 优先级顺序结合
 *      扩展名排列依次尝试。
 *   2. 为未在 tsconfig paths 块中声明别名的项目提供的
 *      旧版硬编码兜底列表（`@/`、`~/`、`src/` ……）。
 *   3. 直接路径查找（带扩展名）。
 */
function resolveAliasedImport(
  importPath: string,
  projectRoot: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const extensions = EXTENSION_RESOLUTION[language] || [];
  const tryWithExt = (basePath: string): string | null => {
    for (const ext of extensions) {
      const candidate = basePath + ext;
      if (context.fileExists(candidate)) return candidate;
    }
    if (context.fileExists(basePath)) return basePath;
    return null;
  };

  // 1. 项目 tsconfig/jsconfig paths。
  const aliasMap = context.getProjectAliases?.();
  if (aliasMap) {
    const candidates = applyAliases(importPath, aliasMap, projectRoot);
    for (const c of candidates) {
      const hit = tryWithExt(c);
      if (hit) return hit;
    }
  }

  // 1.5 工作区包（`@scope/ui/widgets` → `packages/ui/widgets`）。
  //     将 monorepo 成员导入解析到该成员的目录；随后的
  //     扩展名/index 排列会找到其桶文件（#629）。
  const workspaces = context.getWorkspacePackages?.();
  if (workspaces) {
    const base = resolveWorkspaceImport(importPath, workspaces);
    if (base) {
      const hit = tryWithExt(base);
      if (hit) return hit;
    }
  }

  // 2. 硬编码兜底列表。为使用这些惯用别名但未在 tsconfig 中声明的项目保留。
  const fallbackAliases: Record<string, string> = {
    '@/': 'src/',
    '~/': 'src/',
    '@src/': 'src/',
    'src/': 'src/',
    '@app/': 'app/',
    'app/': 'app/',
  };
  for (const [alias, replacement] of Object.entries(fallbackAliases)) {
    if (importPath.startsWith(alias)) {
      const hit = tryWithExt(importPath.replace(alias, replacement));
      if (hit) return hit;
    }
  }

  // 3. 直接路径。
  return tryWithExt(importPath);
}

/**
 * C/C++ 头文件目录缓存（以项目根路径为键）。
 * 每个解析器实例加载一次，跨调用共享。
 */
const cppIncludeDirCache = new Map<string, string[]>();

/**
 * 清除 C/C++ 头文件目录缓存（在索引运行之间调用）
 */
export function clearCppIncludeDirCache(): void {
  cppIncludeDirCache.clear();
}

/**
 * 发现项目的 C/C++ 头文件搜索目录。
 *
 * 策略：
 * 1. 在项目根目录及常见构建子目录中查找 compile_commands.json
 *    （Clang 编译数据库）。从编译命令中解析 -I 和 -isystem 标志。
 * 2. 若未找到编译数据库，则探测常见约定目录（include/、src/、lib/、api/）
 *    以及包含 .h/.hpp 文件的顶层目录。
 *
 * 返回相对于 projectRoot 的路径。
 */
export function loadCppIncludeDirs(projectRoot: string): string[] {
  const cached = cppIncludeDirCache.get(projectRoot);
  if (cached !== undefined) return cached;

  const dirs = loadCppIncludeDirsFromCompileDB(projectRoot)
    || loadCppIncludeDirsHeuristic(projectRoot);

  cppIncludeDirCache.set(projectRoot, dirs);
  return dirs;
}

/**
 * 尝试从 compile_commands.json 加载头文件目录。
 * 若未找到编译数据库则返回 null（以便启用启发式兜底）。
 * 否则返回数组（可能为空）。
 */
function loadCppIncludeDirsFromCompileDB(projectRoot: string): string[] | null {
  const candidates = [
    path.join(projectRoot, 'compile_commands.json'),
    path.join(projectRoot, 'build', 'compile_commands.json'),
    path.join(projectRoot, 'cmake-build-debug', 'compile_commands.json'),
    path.join(projectRoot, 'cmake-build-release', 'compile_commands.json'),
    path.join(projectRoot, 'out', 'compile_commands.json'),
  ];

  let dbPath: string | undefined;
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        dbPath = c;
        break;
      }
    } catch {
      // 忽略
    }
  }
  if (!dbPath) return null;

  try {
    const content = fs.readFileSync(dbPath, 'utf-8');
    const entries = JSON.parse(content) as Array<{
      directory: string;
      command?: string;
      arguments?: string[];
    }>;
    if (!Array.isArray(entries)) return null;

    const dirSet = new Set<string>();
    for (const entry of entries) {
      const dir = entry.directory || projectRoot;
      const args = entry.arguments || (entry.command ? shlexSplit(entry.command) : []);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        let includeDir: string | undefined;
        // -I<dir>（无空格）
        if (arg.startsWith('-I') && arg.length > 2) {
          includeDir = arg.substring(2);
        }
        // -isystem <dir>（空格分隔）
        else if ((arg === '-isystem' || arg === '-I') && i + 1 < args.length) {
          includeDir = args[i + 1];
          i++; // 跳过下一个参数
        }
        if (includeDir) {
          // 规范化：相对于编译目录解析
          const absPath = path.isAbsolute(includeDir)
            ? includeDir
            : path.resolve(dir, includeDir);
          const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
          // 跳过系统目录和项目外部的路径
          // （以 .. 开头的相对路径或绝对路径如
          // /usr/include 或 Windows 上的 C:\usr）
          if (!relPath.startsWith('..') && relPath.length > 0 && !path.isAbsolute(relPath)) {
            dirSet.add(relPath);
          }
        }
      }
    }
    return Array.from(dirSet);
  } catch {
    return null;
  }
}

/**
 * 针对编译器命令字符串的简化 shlex 风格分割。
 * 处理双引号和单引号参数。
 */
function shlexSplit(cmd: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    // 跳过空白字符
    while (i < cmd.length && /\s/.test(cmd[i]!)) i++;
    if (i >= cmd.length) break;
    const ch = cmd[i]!;
    if (ch === '"') {
      i++;
      let arg = '';
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length) { i++; arg += cmd[i]; }
        else { arg += cmd[i]; }
        i++;
      }
      i++; // 闭合引号
      result.push(arg);
    } else if (ch === "'") {
      i++;
      let arg = '';
      while (i < cmd.length && cmd[i] !== "'") { arg += cmd[i]; i++; }
      i++; // 闭合引号
      result.push(arg);
    } else {
      let arg = '';
      while (i < cmd.length && !/\s/.test(cmd[i]!)) { arg += cmd[i]; i++; }
      result.push(arg);
    }
  }
  return result;
}

/**
 * 在不存在 compile_commands.json 时，通过启发式方式发现头文件目录。
 * 检查常见约定目录，并扫描顶层目录中是否包含头文件。
 */
function loadCppIncludeDirsHeuristic(projectRoot: string): string[] {
  const dirs: string[] = [];
  const conventionDirs = ['include', 'src', 'lib', 'api', 'inc'];

  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      // 约定目录
      if (conventionDirs.includes(name.toLowerCase())) {
        dirs.push(name);
        continue;
      }
      // 任何包含 .h 或 .hpp 文件的顶层目录
      try {
        const subFiles = fs.readdirSync(path.join(projectRoot, name));
        if (subFiles.some(f => /\.(h|hpp|hxx|hh)$/i.test(f))) {
          dirs.push(name);
        }
      } catch {
        // 忽略权限错误
      }
    }
  } catch {
    // 忽略
  }

  return dirs;
}

/**
 * 通过搜索头文件目录来解析 C/C++ include 路径。
 * 在相对解析和别名解析均失败后作为兜底调用。
 */
function resolveCppIncludePath(
  importPath: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const includeDirs = context.getCppIncludeDirs?.() ?? [];
  const extensions = EXTENSION_RESOLUTION[language] ?? [];

  for (const dir of includeDirs) {
    const normalizedDir = dir.replace(/\\/g, '/');
    for (const ext of extensions) {
      const candidate = normalizedDir + '/' + importPath + ext;
      if (context.fileExists(candidate)) return candidate;
    }
    // 原样尝试（已含扩展名）
    const candidate = normalizedDir + '/' + importPath;
    if (context.fileExists(candidate)) return candidate;
  }

  return null;
}

/**
 * 判断该引用是否为 PHP include/require 的文件路径（而非命名空间 `use` 符号）。
 *
 * include/require 发出文件路径（"lib.php"、"inc/db.php"、"../x.php"），
 * 而命名空间 use 是 FQN（App\Foo\Bar）或裸类符号（Closure）。
 * PHP 标识符既不含 '/' 也不含 '.'，因此斜杠或点号
 * 标志着路径形式的 include。此类引用只解析到文件，从不解析到同名符号，
 * 因此调用者不得再回退到名称匹配器。
 */
export function isPhpIncludePathRef(ref: UnresolvedRef): boolean {
  return (
    ref.language === 'php' &&
    ref.referenceKind === 'imports' &&
    (ref.referenceName.includes('/') || ref.referenceName.includes('.'))
  );
}

/**
 * 将 PHP include/require 路径解析为项目相对文件路径。
 *
 * PHP 相对于包含文件所在目录来解析 include（过程式代码库的常见情况）；
 * php.ini 的 include_path 不在建模范围内。调用者传入已提取的静态字面量路径。
 */
function resolvePhpIncludePath(
  includePath: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  const projectRoot = context.getProjectRoot();
  const fromDir = path.dirname(path.join(projectRoot, fromFile));
  const basePath = path.resolve(fromDir, includePath);
  const relativePath = path.relative(projectRoot, basePath).replace(/\\/g, '/');
  if (context.fileExists(relativePath)) return relativePath;
  // 字面量可能省略了 .php 扩展名（如 include "config"）。
  for (const ext of EXTENSION_RESOLUTION.php ?? []) {
    if (context.fileExists(relativePath + ext)) return relativePath + ext;
  }
  return null;
}

/**
 * 从文件中提取导入映射
 */
export function extractImportMappings(
  _filePath: string,
  content: string,
  language: Language
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx') {
    mappings.push(...extractJSImports(content));
  } else if (language === 'svelte' || language === 'vue' || language === 'astro') {
    // Svelte/Vue 单文件组件通过其 `<script>` 块内的普通 ES6 导入
    // （Astro：`---` frontmatter）。若缺少此分支，`.svelte`/`.vue`/`.astro`
    // 消费者将产生零条导入映射，`resolveViaImport` 无法运行，
    // 桶导入（`import { Foo } from './lib'`）会回退到名称匹配——
    // 当重导出别名与组件真实名称不同时会静默失败，导致误报 0 callers（#629）。
    // ES6 导入正则只匹配 `import … from '…'`，对整个 SFC（含标记和样式）运行是安全的。
    mappings.push(...extractJSImports(content));
  } else if (language === 'python') {
    mappings.push(...extractPythonImports(content));
  } else if (language === 'go') {
    mappings.push(...extractGoImports(content));
  } else if (language === 'java' || language === 'kotlin') {
    mappings.push(...extractJavaImports(content));
  } else if (language === 'php') {
    mappings.push(...extractPHPImports(content));
  } else if (language === 'c' || language === 'cpp') {
    mappings.push(...extractCppImports(content));
  }

  return mappings;
}

/**
 * 提取 JS/TypeScript 导入映射
 */
function extractJSImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // ES6 imports
  const importRegex = /import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*(?:(\*)\s+as\s+(\w+))?\s*from\s*['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const [, defaultImport, namedImports, star, namespaceAlias, source] = match;

    // 默认导入
    if (defaultImport) {
      mappings.push({
        localName: defaultImport,
        exportedName: 'default',
        source: source!,
        isDefault: true,
        isNamespace: false,
      });
    }

    // 命名导入
    if (namedImports) {
      const names = namedImports.split(',').map((s) => s.trim());
      for (const name of names) {
        const aliasMatch = name.match(/(\w+)\s+as\s+(\w+)/);
        if (aliasMatch) {
          mappings.push({
            localName: aliasMatch[2]!,
            exportedName: aliasMatch[1]!,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        } else if (name) {
          mappings.push({
            localName: name,
            exportedName: name,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        }
      }
    }

    // 命名空间导入
    if (star && namespaceAlias) {
      mappings.push({
        localName: namespaceAlias,
        exportedName: '*',
        source: source!,
        isDefault: false,
        isNamespace: true,
      });
    }
  }

  // Require 语句
  const requireRegex = /(?:const|let|var)\s+(?:(\w+)|{([^}]+)})\s*=\s*require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const [, defaultName, destructured, source] = match;

    if (defaultName) {
      mappings.push({
        localName: defaultName,
        exportedName: 'default',
        source: source!,
        isDefault: true,
        isNamespace: false,
      });
    }

    if (destructured) {
      const names = destructured.split(',').map((s) => s.trim());
      for (const name of names) {
        const aliasMatch = name.match(/(\w+)\s*:\s*(\w+)/);
        if (aliasMatch) {
          mappings.push({
            localName: aliasMatch[2]!,
            exportedName: aliasMatch[1]!,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        } else if (name) {
          mappings.push({
            localName: name,
            exportedName: name,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        }
      }
    }
  }

  return mappings;
}

/**
 * 提取 Python 导入映射
 */
function extractPythonImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // from X import Y
  const fromImportRegex = /from\s+([\w.]+)\s+import\s+([^#\n]+)/g;
  let match;

  while ((match = fromImportRegex.exec(content)) !== null) {
    const [, source, imports] = match;
    const names = imports!.split(',').map((s) => s.trim());

    for (const name of names) {
      const aliasMatch = name.match(/(\w+)\s+as\s+(\w+)/);
      if (aliasMatch) {
        mappings.push({
          localName: aliasMatch[2]!,
          exportedName: aliasMatch[1]!,
          source: source!,
          isDefault: false,
          isNamespace: false,
        });
      } else if (name && name !== '*') {
        mappings.push({
          localName: name,
          exportedName: name,
          source: source!,
          isDefault: false,
          isNamespace: false,
        });
      }
    }
  }

  // import X
  const importRegex = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
  while ((match = importRegex.exec(content)) !== null) {
    const [, source, alias] = match;
    const localName = alias || source!.split('.').pop()!;
    mappings.push({
      localName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  return mappings;
}

/**
 * 提取 Go 导入映射
 */
function extractGoImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // import "path" 或 import alias "path"
  const singleImportRegex = /import\s+(?:(\w+)\s+)?["']([^"']+)["']/g;
  let match;

  while ((match = singleImportRegex.exec(content)) !== null) {
    const [, alias, source] = match;
    const packageName = source!.split('/').pop()!;
    mappings.push({
      localName: alias || packageName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  // import ( ... ) 块
  const blockImportRegex = /import\s*\(\s*([^)]+)\s*\)/gs;
  while ((match = blockImportRegex.exec(content)) !== null) {
    const block = match[1]!;
    const lineRegex = /(?:(\w+)\s+)?["']([^"']+)["']/g;
    let lineMatch;

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const [, alias, source] = lineMatch;
      const packageName = source!.split('/').pop()!;
      mappings.push({
        localName: alias || packageName,
        exportedName: '*',
        source: source!,
        isDefault: false,
        isNamespace: true,
      });
    }
  }

  return mappings;
}

/**
 * 提取 Java/Kotlin 导入映射。
 *
 * Java/Kotlin 导入携带被导入符号的完整限定名——
 * `import com.example.dao.converter.FooConverter;`——
 * 这正是当两个包都声明了 `FooConverter` 时所需的消歧信号。
 * 在 #314 之前，解析器在此处根本没有 Java 分支，
 * 导致该映射为空，跨模块名称冲突只能靠文件路径邻近度解决（往往有误）。
 *
 * `import static com.example.Foo.bar;` 被解析为本地名 `bar`
 * 指向 FQN `com.example.Foo.bar`，以便静态方法调用处
 * （`bar(...)`）能通过相同的导入查找来解析。
 */
function extractJavaImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];
  // 去除行注释和块注释，防止 `// import foo;` 产生误匹配。
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // `import [static] <fqn>[.*];`
  const re = /^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const fqn = match[2]!;
    // `import com.example.*;` — 通配符导入。无法具化为单个本地名；
    // 跳过，让名称匹配器处理通配符可达的成员。（未来增强：枚举包文件。）
    if (fqn.endsWith('.*')) continue;
    const parts = fqn.split('.');
    const localName = parts[parts.length - 1];
    if (!localName) continue;
    mappings.push({
      localName,
      exportedName: localName,
      source: fqn,
      isDefault: false,
      isNamespace: false,
    });
  }
  return mappings;
}

/**
 * 提取 PHP 导入映射（use 语句）
 */
function extractPHPImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // use Namespace\Class; 或 use Namespace\Class as Alias;
  const useRegex = /use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/g;
  let match;

  while ((match = useRegex.exec(content)) !== null) {
    const [, fullPath, alias] = match;
    const className = fullPath!.split('\\').pop()!;
    mappings.push({
      localName: alias || className,
      exportedName: className,
      source: fullPath!,
      isDefault: false,
      isNamespace: false,
    });
  }

  return mappings;
}

/**
 * 从 #include 指令中提取 C/C++ 导入映射。
 *
 * #include 将被包含头文件的所有符号引入作用域
 * （命名空间导入），因此每条映射使用 isNamespace: true 和
 * exportedName: '*'。localName 设为头文件不含扩展名的基名，
 * 以便符号引用（如 `MyClass`）可以匹配任何可能提供该符号的 include。
 */
function extractCppImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // 同时匹配 #include <...> 和 #include "..."
  const includeRegex = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/gm;
  let match;

  while ((match = includeRegex.exec(content)) !== null) {
    const modulePath = match[1]!;
    // 用于 localName 匹配的无扩展名基名
    const basename = modulePath.split('/').pop()!.replace(/\.(h|hpp|hxx|hh|inl|ipp|cxx|cc|cpp)$/,'');
    mappings.push({
      localName: basename || modulePath,
      exportedName: '*',
      source: modulePath,
      isDefault: false,
      isNamespace: true,
    });
  }

  return mappings;
}

// 按文件缓存导入映射，避免重复读取和解析
const importMappingCache = new Map<string, ImportMapping[]>();

/**
 * 清除导入映射缓存（在索引运行之间调用）
 */
export function clearImportMappingCache(): void {
  importMappingCache.clear();
  cppIncludeDirCache.clear();
}

/**
 * 从 `content` 中去除 JS 行注释和块注释，同时保留
 * 字符串字面量（使 `"//"` 在字符串内保持原样）。供
 * {@link extractReExports} 使用，防止注释掉的 export-from 语句
 * 生成幽灵重导出边。
 *
 * 扫描器故意保持精简：它只跟踪 JS/TypeScript 相关的三种上下文——
 * 单引号字符串、双引号字符串和模板字面量。注释识别遵循 JS 规范子集，
 * 不感知正则字面量（对我们的使用场景没问题：此函数不应用于函数体，
 * 只应用于顶层文件）。
 */
function stripJsComments(content: string): string {
  let out = '';
  let i = 0;
  let str: '"' | "'" | '`' | null = null;
  while (i < content.length) {
    const ch = content[i]!;
    if (str !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < content.length) {
        out += content[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === str) str = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      str = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 从 `content` 中提取 JS/TypeScript 重导出声明。
 *
 * 识别以下形式：
 *   export { foo } from './a';
 *   export { foo as bar } from './a';
 *   export * from './a';
 *   export * as ns from './a';   （追踪时视为通配符）
 *   export { default as Foo } from './a';
 *
 * 遍历器有意保持基于正则——本文件其他地方的 import-resolver
 * 已选择正则而非新一轮 tree-sitter 解析，此函数共享该取舍。
 * 错误静默落穿；解析器直接跳过损坏的文件。
 */
export function extractReExports(content: string, language: Language): ReExport[] {
  if (
    language !== 'typescript' &&
    language !== 'javascript' &&
    language !== 'tsx' &&
    language !== 'jsx'
  ) {
    return [];
  }
  const out: ReExport[] = [];

  // 预先去除块注释和行注释，防止注释掉的
  // `// export { x } from '...'` 产生幽灵边。
  // （模板字面量仍可能产生误报；
  // 在运行时构建 export 语句的项目不在支持范围内。）
  const cleaned = stripJsComments(content);

  // 通配符：`export * from '...'` 或 `export * as ns from '...'`
  const wildcardRe = /export\s*\*(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = wildcardRe.exec(cleaned)) !== null) {
    out.push({ kind: 'wildcard', source: m[1]! });
  }

  // 命名：`export { a, b as c } from '...'`
  const namedRe = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = namedRe.exec(cleaned)) !== null) {
    const inner = m[1]!;
    const source = m[2]!;
    for (const raw of inner.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      const aliasMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        out.push({
          kind: 'named',
          exportedName: aliasMatch[2]!,
          originalName: aliasMatch[1]!,
          source,
        });
      } else if (/^\w+$/.test(item)) {
        out.push({
          kind: 'named',
          exportedName: item,
          originalName: item,
          source,
        });
      }
    }
  }

  return out;
}

/**
 * 通过导入映射解析引用
 */
/**
 * JVM（Java/Kotlin）导入使用完整限定名（`import com.example.foo.Bar`），
 * 与文件名解耦，因此当文件名与主符号不一致时（Kotlin `Utils.kt` 导出 `Bar`、
 * 顶层函数、扩展函数），JS/Python 风格的文件系统路径查找会错过它们。
 * 改为通过 `qualifiedName` 索引解析——由提取器中的
 * package_header/package_declaration 命名空间包装器填充。
 */
export function resolveJvmImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  if (ref.language !== 'java' && ref.language !== 'kotlin') return null;

  const fqn = ref.referenceName;
  const lastDot = fqn.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const pkg = fqn.substring(0, lastDot);
  const sym = fqn.substring(lastDot + 1);
  // 通配符导入（`com.example.*`）故意交由名称匹配器处理。
  if (sym === '*') return null;

  const candidates = context.getNodesByQualifiedName(`${pkg}::${sym}`);
  if (candidates.length === 0) return null;

  // Kotlin Multiplatform：`expect` 声明与其 `actual` 实现跨源集（commonMain/androidMain/appleMain）
  // 共享同一 FQN。取第一个候选会让单平台 `actual` 吸收所有来自公共侧的导入，
  // 导致 `expect`（commonMain 文件导入的规范 API）看起来未被使用。
  // 优先选择与导入文件目录最近的候选——commonMain 导入解析到 commonMain 声明——
  // 以 `expect` 侧作为平局决胜。
  const best = candidates.length === 1 ? candidates[0]! : pickClosestJvmCandidate(candidates, ref.filePath);
  return {
    original: ref,
    targetNodeId: best.id,
    confidence: 0.95,
    resolvedBy: 'import',
  };
}

/**
 * 按共享目录前缀的长度，从同 FQN 的候选中选出与 `fromPath` 最近的一个，
 * 平局时优先选择 `expect` 声明。用于确保 Kotlin Multiplatform 的 `expect`/`actual`
 * 导入在导入方自身的源集中解析，而非落到任意平台的 `actual`。
 */
function pickClosestJvmCandidate(candidates: Node[], fromPath: string): Node {
  const fromDirs = fromPath.split('/').slice(0, -1);
  const sharedPrefix = (p: string): number => {
    const d = p.split('/').slice(0, -1);
    let shared = 0;
    for (let i = 0; i < Math.min(fromDirs.length, d.length); i++) {
      if (fromDirs[i] === d[i]) shared++;
      else break;
    }
    return shared;
  };
  const isExpect = (n: Node): boolean => Array.isArray(n.decorators) && n.decorators.includes('expect');
  let best = candidates[0]!;
  let bestProx = sharedPrefix(best.filePath);
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const prox = sharedPrefix(c.filePath);
    if (prox > bestProx || (prox === bestProx && isExpect(c) && !isExpect(best))) {
      best = c;
      bestProx = prox;
    }
  }
  return best;
}

export function resolveViaImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // C/C++ #include 引用——直接解析到被包含文件
  // （file→file 边），绕过符号查找。提取器以
  // `referenceKind: 'imports'` 和 `referenceName: <include 路径>`
  // （如 "uint256.h" 或 "common/args.h"）发出这些引用。若缺少此分支，
  // resolveImportPath 内的 include 目录扫描路径不会产生边——
  // 下方 resolveViaImport 的符号查找会搜索一个与文件扩展名同名的符号并失败。
  if ((ref.language === 'c' || ref.language === 'cpp') && ref.referenceKind === 'imports') {
    // C/C++ 带引号的 include（`#include "X.h"`）优先相对于包含文件自身目录解析
    // （C 标准的带引号 include 搜索顺序）。优先选择同目录的头文件，而非 -I 目录或
    // 另一平台的同名头文件（windows/code/RNCAsyncStorage.h 与
    // apple/.../RNCAsyncStorage.h）——否则 include 目录启发式会随机选取同名头文件，
    // 让真正的本地头文件没有任何依赖方。
    const slash = ref.filePath.lastIndexOf('/');
    const fromDir = slash >= 0 ? ref.filePath.slice(0, slash) : '';
    const siblingPath = path.posix.normalize(fromDir ? `${fromDir}/${ref.referenceName}` : ref.referenceName);
    const siblingBase = siblingPath.split('/').pop()!;
    const sibling = context
      .getNodesByName(siblingBase)
      .find((n) => n.kind === 'file' && n.filePath === siblingPath);
    if (sibling) {
      return { original: ref, targetNodeId: sibling.id, confidence: 0.92, resolvedBy: 'import' };
    }
    const resolvedPath = resolveImportPath(ref.referenceName, ref.filePath, ref.language, context);
    if (!resolvedPath) return null;
    const basename = resolvedPath.split('/').pop()!;
    const fileNodes = context.getNodesByName(basename).filter((n) => n.kind === 'file');
    const fileNode = fileNodes.find((n) => n.filePath === resolvedPath);
    if (fileNode) {
      return {
        original: ref,
        targetNodeId: fileNode.id,
        confidence: 0.9,
        resolvedBy: 'import',
      };
    }
    return null;
  }

  // PHP include/require——将静态字符串路径解析为 file→file 边，
  // 与上方的 C/C++ 分支对应。通过形状区分 include 路径和命名空间 `use` 符号：
  // include 路径包含斜杠或文件扩展名（"lib.php"、"inc/db.php"、"../x.php"），
  // 而命名空间 use 是 FQN（App\Foo\Bar）或裸类符号（Closure）——
  // PHP 标识符既不含 '/' 也不含 '.'。只有路径形式的引用才是 include；
  // 符号引用落穿到命名空间解析。
  if (isPhpIncludePathRef(ref)) {
    const resolvedPath = resolvePhpIncludePath(ref.referenceName, ref.filePath, context);
    if (resolvedPath) {
      const basename = resolvedPath.split('/').pop()!;
      const fileNode = context
        .getNodesByName(basename)
        .find((n) => n.kind === 'file' && n.filePath === resolvedPath);
      if (fileNode) {
        return {
          original: ref,
          targetNodeId: fileNode.id,
          confidence: 0.9,
          resolvedBy: 'import',
        };
      }
    }
    // 路径形式的 include 若无法解析到已知项目文件，则为死路。
    // 返回未解析，而非落穿到符号名称匹配器——否则例如 "inc/db.php"
    // 可能被错误连接到树中其他位置的无关 db.php——错误的边比缺失的边更糟。
    return null;
  }

  // 使用缓存的导入映射（避免每个引用都重复读取和解析）
  const imports = context.getImportMappings(ref.filePath, ref.language);
  if (imports.length === 0 && !context.readFile(ref.filePath)) {
    return null;
  }

  // Go 跨包调用：`pkga.FuncX(...)` 提取为 referenceName `pkga.FuncX`，
  // 导入 `github.com/example/myproject/pkga` 映射到包含一个或多个 .go 文件的
  // *包目录*。下方通用的基于文件的查找无法跟踪此路径——issue #388。
  if (ref.language === 'go') {
    const goResult = resolveGoCrossPackageReference(ref, imports, context);
    if (goResult) return goResult;
  }

  // Java/Kotlin：导入是 FQN（`import com.example.Foo;`）——
  // 下方的 JS/TypeScript 风格链无法跟踪可解析的文件路径。
  // 通过名称查找符号，并过滤到文件路径与导入 FQN 匹配的候选。
  // 这是当路径邻近匹配器无法解决的同名类冲突时的消歧信号（issue #314）。
  if (ref.language === 'java' || ref.language === 'kotlin') {
    const javaResult = resolveJavaImportedReference(ref, imports, context);
    if (javaResult) return javaResult;
  }

  // Python 通过导入模块的限定访问：`from . import certs` 后的 `certs.where()`、
  // `import mod` 后的 `mod.func()`。接收者是子模块（文件），而非符号，
  // 因此下方通用的符号查找会在*包*中搜索 `certs`，而非在模块内部查找。
  if (ref.language === 'python') {
    const pyResult = resolvePythonModuleMember(ref, imports, context);
    if (pyResult) return pyResult;
    // 绝对带点模块导入：`import conduit.apps.articles.signals`
    // （标准 Django AppConfig.ready() 信号注册模式，以及任何副作用
    // `import pkg.mod`）。将带点路径映射到其文件。
    const pyModResult = resolvePythonAbsoluteModule(ref, context);
    if (pyModResult) return pyModResult;
  }

  // Rust 限定路径：将 `crate::m::Item` / `self::sub::Item` / `super::m::func`
  // 的模块前缀解析到文件，再在其中查找叶子符号。消歧名称匹配器会落到错误
  // 同名符号的常见名 `pub use self::read::read` 重导出。
  if (ref.language === 'rust' && ref.referenceName.includes('::')) {
    const rustResult = resolveRustPathReference(ref, context);
    if (rustResult) return rustResult;
  }

  // Lua/Luau `require(...)`：带点的模块路径（`require("a.b.c")` 中的 `a.b.c`）
  // 或实例路径叶子（`require(script.Parent.Signal)` 中的 `Signal`）——
  // 映射到模块文件。由于没有静态 import 语句，通用路径匹配器无法桥接
  // 点号↔斜杠/叶子↔基名的差异；因此显式解析到模块文件。
  if ((ref.language === 'lua' || ref.language === 'luau') && ref.referenceKind === 'imports') {
    const luaResult = resolveLuaRequire(ref, context);
    if (luaResult) return luaResult;
  }

  // 整模块/命名空间导入 → 将导入文件链接到模块文件。
  // Python 的 `from . import certs` / `import mod`，以及 TypeScript/JS 的
  // `import * as ns from './x'`（使仅通过值成员读取访问的命名空间仍能记录依赖）。
  // 命名 TypeScript/JS 导入在此返回 null，落穿到下方的符号解析。
  if (
    ref.language === 'python' ||
    ref.language === 'typescript' ||
    ref.language === 'tsx' ||
    ref.language === 'javascript' ||
    ref.language === 'jsx'
  ) {
    const moduleFile = resolveModuleImportToFile(ref, imports, context);
    if (moduleFile) return moduleFile;
  }

  // 检查引用名称是否匹配任何导入
  for (const imp of imports) {
    if (imp.localName === ref.referenceName || ref.referenceName.startsWith(imp.localName + '.')) {
      // 解析导入路径
      const resolvedPath = resolveImportPath(
        imp.source,
        ref.filePath,
        ref.language,
        context
      );

      if (resolvedPath) {
        const exportedName = imp.isDefault ? 'default' : imp.exportedName;
        const memberName = imp.isNamespace
          ? ref.referenceName.replace(imp.localName + '.', '')
          : null;

        const targetNode = findExportedSymbol(
          resolvedPath,
          { isDefault: imp.isDefault, isNamespace: imp.isNamespace, exportedName, memberName },
          ref.language,
          context,
          new Set()
        );

        if (targetNode) {
          // `Foo.bar()` / `Foo.CONST` — 通过成员访问命名（非命名空间）类导入。
          // `findExportedSymbol` 已将 `Foo` 解析到类本身；向下深入以便引用
          // 链接到成员 `bar`，而非类。若不处理此情况，边会指向类，
          // `createEdges` 会将调用误提升为 `instantiates` 边，
          // 导致静态方法显示零调用方且影响半径为空。（#825）
          if (!imp.isNamespace && ref.referenceName.startsWith(imp.localName + '.')) {
            const memberNode = resolveStaticMember(targetNode, ref, imp.localName, context);
            if (memberNode) {
              return {
                original: ref,
                targetNodeId: memberNode.id,
                confidence: 0.9,
                resolvedBy: 'import',
              };
            }
          }

          return {
            original: ref,
            targetNodeId: targetNode.id,
            confidence: 0.9,
            resolvedBy: 'import',
          };
        }
      }
    }
  }

  return null;
}

/**
 * 解析接收者为已导入模块的 Python 限定引用：
 * `from . import certs` 后的 `certs.where()`；`import mod` 或
 * `from pkg import mod` 后的 `mod.func()`。接收者是子模块（文件），而非符号，
 * 因此 `resolveViaImport` 中的通用符号查找无法跟踪——
 * 它会在*包*中搜索 `certs`/`mod`，而非在模块内部查找。
 * 这是跨包限定调用问题的 Python 半边
 * （参见 Go 的 `pkg.Func` 对应的 `resolveGoCrossPackageReference`，issue #388）。
 *
 * 从绑定构建模块的带点导入路径——`from . import certs` → `.certs`；
 * `from pkg import mod` → `pkg.mod`；`import mod` → `mod`——
 * 解析到模块文件，并查找其中定义的成员。若该路径不存在对应的模块文件，
 * 则返回 null，使已导入*值*上的属性访问（`helper.attr`，`helper` 为函数）
 * 落穿到其他策略。
 */
function resolvePythonModuleMember(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  const dotIdx = ref.referenceName.indexOf('.');
  if (dotIdx <= 0) return null;
  const receiver = ref.referenceName.substring(0, dotIdx);
  // 模块的直接成员（接收者之后的第一个分段）。
  const member = ref.referenceName.substring(dotIdx + 1).split('.')[0];  if (!member) return null;

  for (const imp of imports) {
    if (imp.localName !== receiver) continue;

    // `import mod` / `import numpy as np` 将 `source` 处的模块本身绑定到本地；
    // `from . import certs` / `from pkg import mod` 绑定子模块，
    // 其带点路径为 source 与导入名称的拼接。
    const modulePath = imp.isNamespace
      ? imp.source
      : imp.source.endsWith('.')
        ? imp.source + imp.localName
        : imp.source + '.' + imp.localName;

    // resolveImportPath 只映射相对带点路径（`.mod`、`..pkg.mod`）；
    // 绝对包路径（`from pkg import module` 中的 `pkg.module`，或裸的
    // `import pkg.mod`）在那里解析为 null，因此回退到带点模块文件查找——
    // 与 resolveModuleImportToFile 已处理的 file→file 导入边的同一不对称性。
    // 若不如此，`from pkg import module` 后的 `module.func()` 调用会丢失
    // `calls` 边，即便 import 边已解析（#578）。
    let resolvedPath = resolveImportPath(modulePath, ref.filePath, ref.language, context);
    if (!resolvedPath) {
      resolvedPath = findPythonModuleFile(modulePath, context, ref.filePath)?.filePath ?? null;
    }
    if (!resolvedPath || resolvedPath === ref.filePath) continue;

    // 在模块文件中查找作为顶层定义的成员。排除 `method`，
    // 防止 `mod.foo` 落到同名的类方法上。
    const target = context.getNodesInFile(resolvedPath).find(
      (n) =>
        n.name === member &&
        (n.kind === 'function' ||
          n.kind === 'class' ||
          n.kind === 'variable' ||
          n.kind === 'constant')
    );
    if (target) {
      return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'import' };
    }
  }
  return null;
}

/**
 * 将整模块导入解析到该模块的文件（file→file 依赖）。
 * 被导入的名称是模块，而非符号，因此没有可以解析的目标——
 * 但导入一个模块本身就是对它的依赖。覆盖以下情况：
 *   - Python 子模块导入——`from . import certs`、`from pkg import sub`；
 *   - 命名空间导入——Python 的 `import mod` / `import numpy as np`，以及
 *     TypeScript/JS 的 `import * as ns from './x'`。
 *
 * 也是 {@link resolvePythonModuleMember} 和 TypeScript 命名空间用法的可靠兜底：
 * 即使所用成员在其他地方被重导出（requests 的 `certs.where` 从 `certifi` 重导出）、
 * 用法是未被提取为调用的模块级代码，或 TypeScript 命名空间仅通过值成员读取
 * （`ns.SOME_CONST`）被触及，它也会记录依赖。
 *
 * 仅对无点号的 `imports` 类型引用、且模块路径能解析到真实文件时触发。
 * 命名 TypeScript/JS 导入（`import { widget }`）不是模块，因此返回 null，
 * 由普通符号解析处理。
 */
/**
 * 将 Lua/Luau `require(...)` 解析到其模块文件。引用名称为
 * 带点的模块路径（`telescope.config` → `telescope/config.lua`）或
 * Roblox 实例路径叶子（`require(script.Parent.Signal)` 中的 `Signal` →
 * `Signal.luau`）。尝试 `<path>.lua|.luau` 和 `<path>/init.lua|.luau`，
 * 按路径后缀匹配（模块根——`lua/`、`src/` 等——因项目而异）。
 * 在后缀匹配中，与 require 文件共享最长目录前缀的胜出
 * （实例路径 require 在同一包内解析）。
 */
function resolveLuaRequire(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  if (!name) return null;
  const base = name.includes('.') ? name.replace(/\./g, '/') : name;
  const suffixes = [`${base}.lua`, `${base}.luau`, `${base}/init.lua`, `${base}/init.luau`];
  const files = context.getAllFiles();
  const shared = (a: string, b: string): number => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  for (const suffix of suffixes) {
    const matches = files.filter((f) => f === suffix || f.endsWith('/' + suffix));
    if (matches.length === 0) continue;
    matches.sort((x, y) => shared(y, ref.filePath) - shared(x, ref.filePath));
    const best = matches[0]!;
    if (best === ref.filePath) continue;
    const fileNode = context.getNodesInFile(best).find((n) => n.kind === 'file');
    if (fileNode) {
      // 置信度 ≥ 0.9，使此确定性路径/后缀匹配优先于
      // 名称匹配——否则名称匹配会将 require 解析到 import 节点本身
      // （同名自匹配）。
      return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'import' };
    }
  }
  return null;
}

function resolveModuleImportToFile(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  if (ref.referenceName.includes('.')) return null;

  for (const imp of imports) {
    if (imp.localName !== ref.referenceName) continue;

    let modulePath: string;
    if (imp.isNamespace || imp.isDefault) {
      // `import * as ns from './x'`（命名空间）或 `import x from './x'`
      // （默认）——依赖在模块文件上。默认导入将一个（可能已重命名的）本地名
      // 绑定到模块的默认导出（`import articlesController from './article.controller'`
      // ← `export default router`），因此绑定名称无法作为符号找到——
      // 改为链接到导入解析到的文件。外部模块无法解析（无文件），
      // 故 `import React from 'react'` 不会产生边。
      modulePath = imp.source;
    } else if (ref.language === 'python') {
      // `from . import certs` — 被导入的名称是 source 的子模块。
      modulePath = imp.source.endsWith('.')
        ? imp.source + imp.localName
        : imp.source + '.' + imp.localName;
    } else {
      // 命名 TypeScript/JS 导入绑定的是符号，而非模块——保持不变。
      continue;
    }

    const resolvedPath = resolveImportPath(modulePath, ref.filePath, ref.language, context);
    if (resolvedPath && resolvedPath !== ref.filePath) {
      const fileNode = context.getNodesInFile(resolvedPath).find((n) => n.kind === 'file');
      if (fileNode) {
        return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'import' };
      }
    }

    // Python 绝对 `from a.b import submodule`（FastAPI 路由聚合器的
    // `from app.api.routes import authentication`）：resolveImportPath 只将
    // 相对带点路径映射到文件，因此直接将绝对带点模块解析到其文件节点。
    if (ref.language === 'python') {
      const modFile = findPythonModuleFile(modulePath, context, ref.filePath);
      if (modFile) {
        return { original: ref, targetNodeId: modFile.id, confidence: 0.9, resolvedBy: 'import' };
      }
    }
  }
  return null;
}

/**
 * 查找 Python 带点模块路径 `a.b.c` 的文件节点——以 `a/b/c.py` 结尾的模块文件，
 * 或包 `a/b/c/__init__.py`（按后缀匹配，因此位于 `src/` 等目录下的包仍可解析）。
 * 对标准库/外部模块（无匹配的仓库文件节点）返回 null，从而 `import os`
 * 不会产生边。由绝对 `import a.b.c` 和绝对 `from a.b import c`
 * （其中 `c` 是子模块）的解析共用。
 */
function findPythonModuleFile(
  mod: string,
  context: ResolutionContext,
  excludeFilePath: string
): Node | null {
  if (!mod || mod.startsWith('.')) return null; // 相对导入在其他地方处理
  const rel = mod.replace(/\./g, '/');
  const lastSeg = mod.split('.').pop()!;
  const endsWith = (p: string, want: string): boolean => p === want || p.endsWith('/' + want);
  const moduleFile = context
    .getNodesByName(`${lastSeg}.py`)
    .find((n) => n.kind === 'file' && n.filePath !== excludeFilePath && endsWith(n.filePath, `${rel}.py`));
  if (moduleFile) return moduleFile;
  const pkgFile = context
    .getNodesByName('__init__.py')
    .find((n) => n.kind === 'file' && n.filePath !== excludeFilePath && endsWith(n.filePath, `${rel}/__init__.py`));
  return pkgFile ?? null;
}

/**
 * 将 Python 绝对带点模块导入（`import a.b.c`）解析到其文件——
 * Django `AppConfig.ready(): import myapp.signals` 模式及任何副作用模块导入。
 */
function resolvePythonAbsoluteModule(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  // 只有带点的 `import a.b.c` 引用才携带完整模块路径。裸叶子
  // （`from app.api.routes import authentication`）本身存在歧义——
  // 可能存在三个 `authentication.py` 文件——因此交由 resolveModuleImportToFile，
  // 它使用导入的 source（`app.api.routes`）来构建完整路径。
  if (!ref.referenceName.includes('.')) return null;
  const hit = findPythonModuleFile(ref.referenceName, context, ref.filePath);
  return hit ? { original: ref, targetNodeId: hit.id, confidence: 0.9, resolvedBy: 'import' } : null;
}

/**
 * 通过将模块前缀（`A::B`）映射到文件、再在其中查找叶子符号（`C`），
 * 解析 Rust 限定引用 `A::B::C`。这是 {@link resolvePythonModuleMember} /
 * {@link resolveGoCrossPackageReference} 的 Rust 类似物，
 * 也是名称匹配无法消歧的常见名重导出（`pub use self::read::read`）的精确解答。
 * 当前缀不是真实模块路径时（如 `Widget::new`——`Widget` 是 struct 而非模块），
 * 返回 null，使关联函数调用和枚举变体路径不受影响地落穿。
 */
function resolveRustPathReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const segments = ref.referenceName.split('::').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const leaf = segments[segments.length - 1]!;
  const modSegs = segments.slice(0, -1);

  const file = resolveRustModuleFile(modSegs, ref.filePath, context);
  if (!file || file === ref.filePath) return null;

  const target = context.getNodesInFile(file).find(
    (n) =>
      n.name === leaf &&
      (n.kind === 'function' ||
        n.kind === 'struct' ||
        n.kind === 'enum' ||
        n.kind === 'trait' ||
        n.kind === 'type_alias' ||
        n.kind === 'constant' ||
        n.kind === 'method' ||
        n.kind === 'class' ||
        n.kind === 'interface')
  );
  if (target) {
    return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
  }
  return null;
}

/** crate 根目录（包含 `lib.rs`/`main.rs`），从文件向上查找。 */
function rustCrateRootDir(fromFileAbs: string, context: ResolutionContext): string | null {
  const projectRoot = context.getProjectRoot();
  const toRel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, '/');
  let dir = path.dirname(fromFileAbs);
  for (let i = 0; i < 64; i++) {
    if (context.fileExists(toRel(path.join(dir, 'lib.rs'))) ||
        context.fileExists(toRel(path.join(dir, 'main.rs')))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** 当前文件的模块声明其子模块的目录。 */
function rustSelfModuleDir(fromFileAbs: string): string {
  const base = path.basename(fromFileAbs);
  const dir = path.dirname(fromFileAbs);
  // mod.rs / lib.rs / main.rs 拥有其目录；`foo.rs` 的子模块位于 `foo/` 下。
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  return path.join(dir, base.replace(/\.rs$/, ''));
}

/**
 * 将 Rust 模块路径（不含叶子符号的分段）解析到最后一个模块分段的文件——
 * `crate::a::b` → `<crate>/a/b.rs`（或 `.../b/mod.rs`）。
 * 以 `crate` / `self` / `super` 为锚点；裸路径则相对于 crate 尝试。
 */
function resolveRustModuleFile(
  segments: string[],
  fromFile: string,
  context: ResolutionContext
): string | null {
  if (segments.length === 0) return null;
  const projectRoot = context.getProjectRoot();
  const fromAbs = path.join(projectRoot, fromFile);
  const toRel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, '/');

  // 从 `startDir` 开始沿模块分段向下遍历，将每个分段映射到
  // `<seg>.rs` 或 `<seg>/mod.rs` 文件。返回叶子模块的文件；
  // 若 `startDir` 为 null 或任意分段在磁盘上没有对应文件，则返回 null。
  const resolveUnder = (startDir: string | null, rest: string[]): string | null => {
    if (!startDir) return null;
    let dir = startDir;
    let targetFile: string | null = null;
    for (const seg of rest) {
      if (seg === 'self' || seg === 'crate' || seg === 'super') continue;
      const asFile = toRel(path.join(dir, seg + '.rs'));
      const asMod = toRel(path.join(dir, seg, 'mod.rs'));
      if (context.fileExists(asFile)) targetFile = asFile;
      else if (context.fileExists(asMod)) targetFile = asMod;
      else return null;
      dir = path.join(dir, seg);
    }
    return targetFile;
  };

  const first = segments[0]!;
  if (first === 'crate') {
    return resolveUnder(rustCrateRootDir(fromAbs, context), segments.slice(1));
  }
  if (first === 'self') {
    return resolveUnder(rustSelfModuleDir(fromAbs), segments.slice(1));
  }
  if (first === 'super') {
    let supers = 0;
    while (segments[supers] === 'super') supers++;
    let dir: string | null = rustSelfModuleDir(fromAbs);
    for (let s = 0; s < supers && dir; s++) dir = path.dirname(dir);
    return resolveUnder(dir, segments.slice(supers));
  }
  // 裸路径。在表达式位置（`submodule::item()`——路由组装及通用跨模块调用模式），
  // 前缀是当前模块的子模块，即 2018 edition `self::` 相对——
  // 因此优先尝试 self 相对。回退到 crate 相对以兼容 2015 edition / crate 根项目。
  // 外部 crate 路径（`serde::de::Error`）两者均不匹配，落穿到名称匹配器。
  return (
    resolveUnder(rustSelfModuleDir(fromAbs), segments) ??
    resolveUnder(rustCrateRootDir(fromAbs, context), segments)
  );
}

/**
 * 解析接收者为已导入 FQN 简单名的 Java/Kotlin 引用：
 * `Foo.bar(...)` 对应 `import com.example.Foo;`。
 * 已导入的 FQN 转换为文件路径后缀（`com/example/Foo.java` 或 `.kt`），
 * 当多个类共享同一简单名时，可唯一标识正确的符号。
 *
 * 也处理对已导入类本身的裸引用
 * （`new Foo()` 提取时以 `references`/`instantiates` 引用发出 `Foo`）
 * 以及 `import static <Foo>.bar` 风格的单成员导入。
 */
function resolveJavaImportedReference(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  if (imports.length === 0) return null;

  const ext = ref.language === 'kotlin' ? '.kt' : '.java';

  for (const imp of imports) {
    const matchesBare = imp.localName === ref.referenceName;
    const matchesQualified = ref.referenceName.startsWith(imp.localName + '.');
    if (!matchesBare && !matchesQualified) continue;

    // 将 FQN 转换为文件路径后缀。`com.example.Foo` →
    // `com/example/Foo.java`（或 `.kt`）。实际文件可能位于
    // 任意源根目录下（`src/main/java/`、`src/` 等），
    // 因此按后缀而非精确路径匹配。
    const fqnPath = imp.source.replace(/\./g, '/') + ext;

    // 要查找的符号名：类本身或成员。
    const memberName = matchesBare
      ? imp.localName
      : ref.referenceName.substring(imp.localName.length + 1);

    const candidates = context.getNodesByName(memberName);
    for (const node of candidates) {
      if (node.language !== ref.language) continue;
      const fp = node.filePath.replace(/\\/g, '/');
      if (fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath)) {
        return {
          original: ref,
          targetNodeId: node.id,
          confidence: 0.9,
          resolvedBy: 'import',
        };
      }
    }

    // `import static com.example.Foo.bar;` — FQN 的尾部是成员名，
    // 前面部分是所有者类。查找名为 `<imp.localName>`（如 `bar`）的成员，
    // 并优先选择文件匹配父 FQN 路径的候选。
    if (matchesBare) {
      const dot = imp.source.lastIndexOf('.');
      if (dot > 0) {
        const ownerFqn = imp.source.substring(0, dot);
        const ownerPath = ownerFqn.replace(/\./g, '/') + ext;
        for (const node of candidates) {
          if (node.language !== ref.language) continue;
          const fp = node.filePath.replace(/\\/g, '/');
          if (fp.endsWith(ownerPath) || fp.endsWith('/' + ownerPath)) {
            return {
              original: ref,
              targetNodeId: node.id,
              confidence: 0.9,
              resolvedBy: 'import',
            };
          }
        }
      }
    }
  }
  return null;
}

/**
 * 通过将包别名与模块内导入匹配、去掉模块前缀得到项目相对目录、
 * 并在该目录下的任意 `.go` 文件中定位导出符号，解析 Go 跨包限定引用（`pkga.FuncX`）。
 * 对标准库/第三方导入返回 `null`（无 go.mod 相对匹配），
 * 以便 `resolveViaImport` 的其余部分仍可尝试基于文件的路径。
 */
function resolveGoCrossPackageReference(
  ref: UnresolvedRef,
  imports: ImportMapping[],
  context: ResolutionContext
): ResolvedRef | null {
  const mod = context.getGoModule?.();
  if (!mod) return null;

  // 限定调用：点号前为接收者，点号后为成员。裸引用
  // （无点号）是同文件/包内调用——在其他地方处理。
  const dotIdx = ref.referenceName.indexOf('.');
  if (dotIdx <= 0) return null;
  const receiver = ref.referenceName.substring(0, dotIdx);
  const memberName = ref.referenceName.substring(dotIdx + 1);
  if (!memberName) return null;

  for (const imp of imports) {
    if (imp.localName !== receiver) continue;
    // 只有模块内导入才能映射到已知目录。
    if (imp.source !== mod.modulePath && !imp.source.startsWith(mod.modulePath + '/')) {
      continue;
    }
    const pkgDir = imp.source === mod.modulePath
      ? ''
      : imp.source.substring(mod.modulePath.length + 1);

    // 按名称查找成员，并选择文件直接位于包目录下的候选。
    // 精确匹配直接父目录，防止 `pkga.FuncX` 的调用意外落到
    // `pkga/subpkg/` 中声明的 `FuncX` 上。
    const candidates = context.getNodesByName(memberName);
    for (const node of candidates) {
      if (node.language !== 'go') continue;
      if (!node.isExported) continue;
      const fp = node.filePath.replace(/\\/g, '/');
      const lastSlash = fp.lastIndexOf('/');
      const fileDir = lastSlash >= 0 ? fp.substring(0, lastSlash) : '';
      if (fileDir === pkgDir) {
        return {
          original: ref,
          targetNodeId: node.id,
          confidence: 0.9,
          resolvedBy: 'import',
        };
      }
    }
  }
  return null;
}

/** 重导出链追踪的递归深度上限。真实代码库中桶文件嵌套
 *  很少超过 2–3 层；8 是一个宽松的安全网，仍能限制最坏情况的工作量。 */
const REEXPORT_MAX_DEPTH = 8;

/**
 * 在 `filePath` 中查找导出的符号，追踪 `export { x } from './other'`
 * 和 `export * from './other'` 链，直到找到原始声明为止。
 * 通过 `visited` 集合保证环路安全。
 *
 * 若缺少此函数，所有桶风格导入（`import { Foo } from './index'`，
 * 其中 `index.ts` 仅重导出）以前都会解析失败——原有代码只在
 * 解析到的文件中查找声明，而不查找该文件转发的声明。
 */
function findExportedSymbol(
  filePath: string,
  want: {
    isDefault: boolean;
    isNamespace: boolean;
    exportedName: string;
    memberName: string | null;
  },
  language: Language,
  context: ResolutionContext,
  visited: Set<string>,
  depth = 0
): Node | undefined {
  if (depth > REEXPORT_MAX_DEPTH) return undefined;
  if (visited.has(filePath)) return undefined;
  visited.add(filePath);

  const nodesInFile = context.getNodesInFile(filePath);

  // 1. 直接命中：符号在此文件中声明。
  if (want.isDefault) {
    // Svelte/Vue 单文件组件本身就是模块的默认导出，
    // 但被提取为 kind 'component'（而非 function/class）。优先选择
    // component 节点；对于 `.ts`/`.tsx` 的 `export default fn`/`class` 情况
    // 回退到已导出的 function/class。若缺少 component 分支，
    // `export { default as X } from './X.svelte'` 桶永远无法解析，
    // 导致组件误报 0 callers（#629）。
    const direct =
      nodesInFile.find((n) => n.isExported && n.kind === 'component') ??
      nodesInFile.find(
        (n) => n.isExported && (n.kind === 'function' || n.kind === 'class')
      );
    if (direct) return direct;
  } else if (want.isNamespace && want.memberName) {
    const direct = nodesInFile.find(
      (n) => n.name === want.memberName && n.isExported
    );
    if (direct) return direct;
  } else {
    const direct = nodesInFile.find(
      (n) => n.name === want.exportedName && n.isExported
    );
    if (direct) return direct;
  }

  // 2. 重导出命中：文件将符号转发到另一个模块。
  const reExports = context.getReExports?.(filePath, language) ?? [];
  if (reExports.length === 0) return undefined;

  // 查找显式 `export { want } from './other'`（可含重命名）。
  const targetName = want.isDefault ? 'default' : want.exportedName;
  for (const rex of reExports) {
    if (rex.kind === 'named' && rex.exportedName === targetName) {
      const next = resolveImportPath(rex.source, filePath, language, context);
      if (!next) continue;
      // 重命名后：`export { foo as bar } from './x'` — 要追踪
      // `bar`，需在 `./x` 中查找 `foo`。
      const chained = findExportedSymbol(
        next,
        {
          isDefault: rex.originalName === 'default',
          isNamespace: false,
          exportedName: rex.originalName,
          memberName: null,
        },
        language,
        context,
        visited,
        depth + 1
      );
      if (chained) return chained;
    }
  }

  // 3. 通配符重导出：`export * from './other'` — 尝试所有转发源。
  //    这是桶中桶的情况。
  for (const rex of reExports) {
    if (rex.kind === 'wildcard') {
      const next = resolveImportPath(rex.source, filePath, language, context);
      if (!next) continue;
      const chained = findExportedSymbol(next, want, language, context, visited, depth + 1);
      if (chained) return chained;
    }
  }

  return undefined;
}

/** 拥有可通过 `Container.member` 访问的静态成员的节点类型。 */
const STATIC_MEMBER_CONTAINERS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'enum', 'trait', 'protocol',
]);

/**
 * 解析 `Container.member`——对命名类导入（`import { Foo } …; Foo.bar()`）
 * 的静态方法/属性访问——到成员节点，其中容器类已经解析完毕。
 *
 * 成员的 qualifiedName 形如 `Container::member`，因此在容器自身文件内
 * 查找 `${container.qualifiedName}::${member}`（文件过滤消歧其他模块中的同名类）。
 * 当容器不是可拥有成员的类型、或成员未找到时返回 undefined，
 * 以便调用方回退到容器本身（原有行为）——
 * 成员非 `::` 限定的语言以及纯粹的类引用均不受影响。参见 #825。
 */
function resolveStaticMember(
  container: Node,
  ref: UnresolvedRef,
  localName: string,
  context: ResolutionContext
): Node | undefined {
  if (!STATIC_MEMBER_CONTAINERS.has(container.kind)) return undefined;
  // 接收者之后的第一个分段：`Foo.bar.baz` → `bar`。
  const member = ref.referenceName.slice(localName.length + 1).split('.')[0];
  if (!member) return undefined;

  const candidates = context
    .getNodesByQualifiedName(`${container.qualifiedName}::${member}`)
    .filter((n) => n.filePath === container.filePath);
  if (candidates.length === 0) return undefined;

  // 当引用是调用时，若多个节点共享 qualifiedName（如静态属性和方法），
  // 优先选择可调用的成员。
  if (ref.referenceKind === 'calls') {
    const callable = candidates.find((n) => n.kind === 'method' || n.kind === 'function');
    if (callable) return callable;
  }
  return candidates[0];
}
