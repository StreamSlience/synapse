/**
 * 引用解析协调器
 *
 * 统筹协调所有引用解析策略。
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node, UnresolvedReference, Edge } from '../types';
import { QueryBuilder } from '../db/queries';
import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionResult,
  ResolutionContext,
  FrameworkResolver,
  ImportMapping,
} from './types';
import { matchReference, matchFunctionRef, matchDottedCallChain, matchScopedCallChain, sameLanguageFamily, crossesKnownFamily } from './name-matcher';
import { resolveViaImport, resolveJvmImport, extractImportMappings, extractReExports, loadCppIncludeDirs, isPhpIncludePathRef } from './import-resolver';
import { detectFrameworks } from './frameworks';
import { synthesizeCallbackEdges } from './callback-synthesizer';
import { loadProjectAliases, type AliasMap } from './path-aliases';
import { loadGoModule, type GoModule } from './go-module';
import { loadWorkspacePackages, type WorkspacePackages } from './workspace-packages';
import { logDebug } from '../errors';
import type { ReExport } from './types';
import { LRUCache } from './lru-cache';

/** 可以声明超类型（extends/implements）的节点类型。 */
const SUPERTYPE_BEARING_KINDS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum',
]);

/**
 * 链式静态工厂/流式调用会推迟到一致性第二遍处理的语言。
 * 点号接收者语言通过 matchDottedCallChain 解析；
 * `::` 接收者语言（Rust）通过 matchScopedCallChain 解析。
 */
const CHAIN_LANGUAGES = new Set(['java', 'kotlin', 'csharp', 'swift', 'rust', 'go', 'scala', 'dart', 'objc', 'pascal']);
const SCOPED_CHAIN_LANGUAGES = new Set(['rust']);

/** 提取器的链式接收者编码格式：`<inner>().<method>`。 */
const CHAIN_SHAPE = /^(.+)\(\)\.(\w+)$/;

/**
 * 缓存大小限制。每个解析器的缓存都有上限，确保在大型代码库（20k+ 文件）上
 * 内存保持平稳。大小的选取以覆盖典型解析批次的工作集为准，最坏情况下不超过
 * 数百 MB。可通过环境变量 `SYNAPSE_RESOLVER_CACHE_SIZE`（单个整数，
 * 应用于所有缓存）在超大或超小项目上进行调优。
 */
const DEFAULT_CACHE_LIMIT = 5_000;
function resolveCacheLimit(): number {
  const raw = process.env.SYNAPSE_RESOLVER_CACHE_SIZE;
  if (!raw) return DEFAULT_CACHE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_CACHE_LIMIT;
}

// 重新导出类型
export * from './types';

// 预构建的 Set，用于 O(1) 内置符号查找（只分配一次，所有实例共享）
const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
]);

const PYTHON_BUILT_INS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'super', 'self', 'cls', 'None', 'True', 'False',
]);

const PYTHON_BUILT_IN_TYPES = new Set([
  'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'bytes', 'bytearray', 'frozenset', 'object', 'super',
]);

const PYTHON_BUILT_IN_METHODS = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'sort', 'reverse', 'copy',
  'update', 'keys', 'values', 'items', 'get',
  'add', 'discard', 'union', 'intersection', 'difference',
  'split', 'join', 'strip', 'lstrip', 'rstrip', 'replace', 'lower', 'upper',
  'startswith', 'endswith', 'find', 'index', 'count', 'encode', 'decode',
  'format', 'isdigit', 'isalpha', 'isalnum',
  'read', 'write', 'readline', 'readlines', 'close', 'flush', 'seek',
]);

const GO_STDLIB_PACKAGES = new Set([
  'fmt', 'os', 'io', 'net', 'http', 'log', 'math', 'sort', 'sync',
  'time', 'path', 'bytes', 'strings', 'strconv', 'errors', 'context',
  'json', 'xml', 'csv', 'html', 'template', 'regexp', 'reflect',
  'runtime', 'testing', 'flag', 'bufio', 'crypto', 'encoding',
  'filepath', 'hash', 'mime', 'rand', 'signal', 'sql', 'syscall',
  'unicode', 'unsafe', 'atomic', 'binary', 'debug', 'exec', 'heap',
  'ring', 'scanner', 'tar', 'zip', 'gzip', 'zlib', 'tls', 'url',
  'user', 'pprof', 'trace', 'ast', 'build', 'parser', 'printer',
  'token', 'types', 'cgo', 'plugin', 'race', 'ioutil',
  // Kubernetes 常用标准库别名
  'utilruntime', 'utilwait', 'utilnet',
]);

const GO_BUILT_INS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'error', 'nil', 'true', 'false', 'iota',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'string', 'bool', 'byte', 'rune', 'any',
]);

const PASCAL_UNIT_PREFIXES = [
  'System.', 'Winapi.', 'Vcl.', 'Fmx.', 'Data.', 'Datasnap.',
  'Soap.', 'Xml.', 'Web.', 'REST.', 'FireDAC.', 'IBX.',
  'IdHTTP', 'IdTCP', 'IdSSL',
];

const PASCAL_BUILT_INS = new Set([
  'System', 'SysUtils', 'Classes', 'Types', 'Variants', 'StrUtils',
  'Math', 'DateUtils', 'IOUtils', 'Generics.Collections', 'Generics.Defaults',
  'Rtti', 'TypInfo', 'SyncObjs', 'RegularExpressions',
  'SysInit', 'Windows', 'Messages', 'Graphics', 'Controls', 'Forms',
  'Dialogs', 'StdCtrls', 'ExtCtrls', 'ComCtrls', 'Menus', 'ActnList',
  'WriteLn', 'Write', 'ReadLn', 'Read', 'Inc', 'Dec', 'Ord', 'Chr',
  'Length', 'SetLength', 'High', 'Low', 'Assigned', 'FreeAndNil',
  'Format', 'IntToStr', 'StrToInt', 'FloatToStr', 'StrToFloat',
  'Trim', 'UpperCase', 'LowerCase', 'Pos', 'Copy', 'Delete', 'Insert',
  'Now', 'Date', 'Time', 'DateToStr', 'StrToDate',
  'Raise', 'Exit', 'Break', 'Continue', 'Abort',
  'True', 'False', 'nil', 'Self', 'Result',
  'Create', 'Destroy', 'Free',
  'TObject', 'TComponent', 'TPersistent', 'TInterfacedObject',
  'TList', 'TStringList', 'TStrings', 'TStream', 'TMemoryStream', 'TFileStream',
  'Exception', 'EAbort', 'EConvertError', 'EAccessViolation',
  'IInterface', 'IUnknown',
]);

const C_BUILT_INS = new Set([
  // 标准 C 库函数
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf',
  'malloc', 'calloc', 'realloc', 'free',
  'memcpy', 'memmove', 'memset', 'memcmp', 'memchr',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp',
  'strstr', 'strchr', 'strrchr', 'strtok', 'strdup',
  'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs', 'fputc', 'fgetc',
  'feof', 'ferror', 'fflush', 'fseek', 'ftell', 'rewind',
  'exit', 'abort', 'atexit', 'atoi', 'atol', 'atof', 'strtol', 'strtoul', 'strtod',
  'qsort', 'bsearch',
  'abs', 'labs', 'rand', 'srand',
  'sin', 'cos', 'tan', 'sqrt', 'pow', 'log', 'log10', 'exp', 'ceil', 'floor', 'fabs',
  'time', 'clock', 'difftime', 'mktime', 'localtime', 'gmtime', 'strftime', 'asctime',
  'assert', 'errno',
  'perror', 'remove', 'rename', 'tmpfile', 'tmpnam',
  'getenv', 'system',
  'signal', 'raise',
  'setjmp', 'longjmp',
  'va_start', 'va_end', 'va_arg', 'va_copy',
  'NULL', 'EOF', 'BUFSIZ', 'FILENAME_MAX', 'RAND_MAX', 'EXIT_SUCCESS', 'EXIT_FAILURE',
  'size_t', 'ptrdiff_t', 'wchar_t', 'intptr_t', 'uintptr_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'FILE',
  // 常见的 POSIX 扩展
  'stat', 'lstat', 'fstat', 'open', 'close', 'read', 'write', 'pipe',
  'fork', 'exec', 'waitpid', 'getpid', 'getppid', 'kill', 'sleep', 'usleep',
  'pthread_create', 'pthread_join', 'pthread_mutex_lock', 'pthread_mutex_unlock',
  'dlopen', 'dlsym', 'dlclose',
]);

const CPP_BUILT_INS = new Set([
  // iostream 对象（通过 using 声明后常不带 std:: 前缀直接使用）
  'cout', 'cin', 'cerr', 'clog', 'endl', 'flush', 'ws',
  'std', // 命名空间本身，在 std::something 形式时使用
  // 会泄漏为引用的常见 C++ 关键字
  'nullptr', 'true', 'false', 'this', 'sizeof', 'alignof', 'typeid',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
  'make_unique', 'make_shared', 'make_pair',
  'move', 'forward', 'swap',
]);

/**
 * 引用解析器
 *
 * 使用多种策略协调引用解析。
 */
export class ReferenceResolver {
  private projectRoot: string;
  private queries: QueryBuilder;
  private context: ResolutionContext;
  private frameworks: FrameworkResolver[] = [];
  // 第一遍无法解析的链式静态工厂/流式调用引用，保存在内存中
  // （批量解析器会从数据库中删除未解析的引用，因此无法再次读取）。
  // 待 implements/extends 边建立后，由 resolveChainedCallsViaConformance 消费，
  // 以解析接收者所符合的超类型上的方法（#750）。
  private deferredChainRefs: UnresolvedRef[] = [];
  // `this.<成员>` 函数引用中，成员不在封闭类本身的情况——可能是继承而来。
  // 与 deferredChainRefs 同样原因保存在内存中，待 implements/extends 边建立后，
  // 由 resolveDeferredThisMemberRefs 消费（#808）。
  private deferredThisMemberRefs: UnresolvedRef[] = [];
  // 每个 `.razor`/`.cshtml` 文件的 `@using` 命名空间集合（本文件指令 + 文件夹
  // `_Imports.razor`，逐级向上级联至项目根目录）。用于将标记类型引用
  // 消歧到正确的 C# 命名空间。
  private razorUsingsCache = new Map<string, string[]>();
  // 所有每解析器缓存均受 LRU 限制。此前这些都是无界 Map，
  // 随着每次不同的查找不断增长，在 20k+ 文件的代码库上会导致 OOM
  // （参见 issue：无界缓存增长）。
  private nodeCache: LRUCache<string, Node[]>; // 每文件节点缓存
  private fileCache: LRUCache<string, string | null>; // 每文件内容缓存
  private importMappingCache: LRUCache<string, ImportMapping[]>;
  private reExportCache: LRUCache<string, ReExport[]>;
  private nameCache: LRUCache<string, Node[]>; // 名称 → 节点缓存
  private lowerNameCache: LRUCache<string, Node[]>; // lower(name) → 节点缓存
  private qualifiedNameCache: LRUCache<string, Node[]>; // qualified_name → 节点缓存
  private knownNames: Set<string> | null = null; // 所有已知符号名称，用于快速预过滤
  private knownFiles: Set<string> | null = null;
  private cachesWarmed = false;
  // tsconfig/jsconfig 路径别名映射。`undefined` = 尚未计算，
  // `null` = 已计算但不存在。在解析器生命周期内视为不可变；
  // 若配置变更，调用方需重新创建解析器。
  private projectAliases: AliasMap | null | undefined = undefined;
  // go.mod 模块路径。与 projectAliases 相同的懒加载/不可变约定。
  private goModule: GoModule | null | undefined = undefined;
  // Monorepo 工作区成员包。与 projectAliases 相同的懒加载/不可变约定。
  private workspacePackages: WorkspacePackages | null | undefined = undefined;

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;

    const limit = resolveCacheLimit();
    // 内容缓存较重（存储完整文件文本），因此给它分配比元数据缓存更小的预算。
    const contentLimit = Math.max(64, Math.floor(limit / 5));
    this.nodeCache = new LRUCache(limit);
    this.fileCache = new LRUCache(contentLimit);
    this.importMappingCache = new LRUCache(limit);
    this.reExportCache = new LRUCache(limit);
    this.nameCache = new LRUCache(limit);
    this.lowerNameCache = new LRUCache(limit);
    this.qualifiedNameCache = new LRUCache(limit);

    this.context = this.createContext();
  }

  /**
   * 初始化解析器（检测框架等）
   */
  initialize(): void {
    this.frameworks = detectFrameworks(this.context);
    this.clearCaches();
  }

  /**
   * 运行每个框架解析器的跨文件收尾处理，并持久化返回的节点更新。
   * 幂等——在每次 indexAll 和每次增量同步后都可安全调用。返回已更新的节点数。
   *
   * 缓存会在前后各清理一次，确保后置提取遍能看到最新的数据库状态，
   * 下游查询也能看到更新后的名称。
   */
  runPostExtract(): number {
    let updated = 0;
    this.clearCaches();
    for (const fw of this.frameworks) {
      if (!fw.postExtract) continue;
      try {
        const nodes = fw.postExtract(this.context);
        for (const node of nodes) {
          this.queries.updateNode(node);
          updated++;
        }
      } catch (err) {
        logDebug(`Framework '${fw.name}' postExtract failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (updated > 0) this.clearCaches();
    return updated;
  }

  /**
   * 预构建轻量级缓存以加速解析。
   * 节点查找现在通过带索引的 SQLite 查询处理，而不是将所有节点加载到内存
   * （后者在大型代码库上会导致 OOM）。
   * 我们缓存已知符号名称集合，用于快速预过滤。
   */
  warmCaches(): void {
    if (this.cachesWarmed) return;

    // 只缓存已知文件路径集合（轻量字符串集合）
    this.knownFiles = new Set(this.queries.getAllFilePaths());

    // 缓存所有不同的符号名称，用于快速预过滤（只存储字符串，不存储完整节点）
    this.knownNames = new Set(this.queries.getAllNodeNames());

    this.cachesWarmed = true;
  }

  /**
   * 清除内部缓存
   */
  clearCaches(): void {
    this.nodeCache.clear();
    this.fileCache.clear();
    this.importMappingCache.clear();
    this.reExportCache.clear();
    this.nameCache.clear();
    this.lowerNameCache.clear();
    this.qualifiedNameCache.clear();
    this.knownNames = null;
    this.knownFiles = null;
    this.cachesWarmed = false;
  }

  /**
   * 创建解析上下文
   */
  private createContext(): ResolutionContext {
    return {
      getNodesInFile: (filePath: string) => {
        if (!this.nodeCache.has(filePath)) {
          this.nodeCache.set(filePath, this.queries.getNodesByFile(filePath));
        }
        return this.nodeCache.get(filePath)!;
      },

      getNodesByName: (name: string) => {
        const cached = this.nameCache.get(name);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByName(name);
        this.nameCache.set(name, result);
        return result;
      },

      getNodesByQualifiedName: (qualifiedName: string) => {
        const cached = this.qualifiedNameCache.get(qualifiedName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByQualifiedNameExact(qualifiedName);
        this.qualifiedNameCache.set(qualifiedName, result);
        return result;
      },

      getNodesByKind: (kind: Node['kind']) => {
        return this.queries.getNodesByKind(kind);
      },

      fileExists: (filePath: string) => {
        // 优先检查预构建的已知文件集合（O(1)）
        if (this.knownFiles) {
          const normalized = filePath.replace(/\\/g, '/');
          if (this.knownFiles.has(filePath) || this.knownFiles.has(normalized)) {
            return true;
          }
        }
        // 回退到文件系统，处理尚未索引的文件
        const fullPath = path.join(this.projectRoot, filePath);
        try {
          return fs.existsSync(fullPath);
        } catch (error) {
          logDebug('Error checking file existence', { filePath, error: String(error) });
          return false;
        }
      },

      readFile: (filePath: string) => {
        if (this.fileCache.has(filePath)) {
          return this.fileCache.get(filePath)!;
        }

        const fullPath = path.join(this.projectRoot, filePath);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          this.fileCache.set(filePath, content);
          return content;
        } catch (error) {
          logDebug('Failed to read file for resolution', { filePath, error: String(error) });
          this.fileCache.set(filePath, null);
          return null;
        }
      },

      getProjectRoot: () => this.projectRoot,

      getAllFiles: () => {
        return this.queries.getAllFilePaths();
      },

      listDirectories: (relativePath: string) => {
        const target = relativePath === '.' || relativePath === ''
          ? this.projectRoot
          : path.join(this.projectRoot, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch (error) {
          logDebug('Failed to list directory for resolution', {
            relativePath,
            error: String(error),
          });
          return [];
        }
      },

      getNodesByLowerName: (lowerName: string) => {
        const cached = this.lowerNameCache.get(lowerName);
        if (cached !== undefined) return cached;
        const result = this.queries.getNodesByLowerName(lowerName);
        this.lowerNameCache.set(lowerName, result);
        return result;
      },

      getNodeById: (id: string) => {
        return this.queries.getNodeById(id);
      },

      getSupertypes: (typeName: string, language) => {
        // 合并每个同名类型节点的 `implements`/`extends` 目标。
        // 按简单名称（非 id）匹配，可将声明在一个节点中的类型
        // （`KF::Builder`）与声明在独立扩展节点中的一致性
        // （`KF.Builder: KFOptionSetter`）关联起来——两者的名称均为 `Builder`。
        const typeNodes = this.context
          .getNodesByName(typeName)
          .filter((n) => SUPERTYPE_BEARING_KINDS.has(n.kind) && n.language === language);
        if (typeNodes.length === 0) return [];
        const supertypes = new Set<string>();
        for (const tn of typeNodes) {
          for (const edge of this.queries.getOutgoingEdges(tn.id, ['implements', 'extends'])) {
            const target = this.queries.getNodeById(edge.target);
            if (target?.name && target.name !== typeName) supertypes.add(target.name);
          }
        }
        return [...supertypes];
      },

      getImportMappings: (filePath: string, language) => {
        const cacheKey = filePath;
        const cached = this.importMappingCache.get(cacheKey);
        if (cached) return cached;

        const content = this.context.readFile(filePath);
        if (!content) {
          this.importMappingCache.set(cacheKey, []);
          return [];
        }

        const mappings = extractImportMappings(filePath, content, language);
        this.importMappingCache.set(cacheKey, mappings);
        return mappings;
      },

      getProjectAliases: () => {
        if (this.projectAliases === undefined) {
          this.projectAliases = loadProjectAliases(this.projectRoot);
        }
        return this.projectAliases;
      },

      getGoModule: () => {
        if (this.goModule === undefined) {
          this.goModule = loadGoModule(this.projectRoot);
        }
        return this.goModule;
      },

      getWorkspacePackages: () => {
        if (this.workspacePackages === undefined) {
          this.workspacePackages = loadWorkspacePackages(this.projectRoot);
        }
        return this.workspacePackages;
      },

      getReExports: (filePath: string, language) => {
        const cached = this.reExportCache.get(filePath);
        if (cached) return cached;
        const content = this.context.readFile(filePath);
        if (!content) {
          this.reExportCache.set(filePath, []);
          return [];
        }
        // 重导出是 JS/TS 特有的构造，关键是桶文件本身的语言——
        // 而非消费方引用的语言。`.svelte`/`.vue` 消费方会将自身语言
        // 传入重导出链，这会导致 extractReExports() 在 `.ts` index 桶文件上
        // 中止，悄无声息地断开链条（#629）。改为按桶文件的扩展名来
        // 确定解析语言，确保无论哪种文件通过它导入，追踪都能正常工作。
        const isJsFamily = /\.(?:d\.ts|[cm]?tsx?|[cm]?jsx?)$/i.test(filePath);
        const reExports = extractReExports(content, isJsFamily ? 'typescript' : language);
        this.reExportCache.set(filePath, reExports);
        return reExports;
      },

      getCppIncludeDirs: () => {
        return loadCppIncludeDirs(this.projectRoot);
      },
    };
  }

  /**
   * 解析所有未解析的引用
   */
  resolveAll(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    // 预加载所有节点到内存以加速查找
    this.warmCaches();

    const resolved: ResolvedRef[] = [];
    const unresolved: UnresolvedRef[] = [];
    const byMethod: Record<string, number> = {};

    // 转换为内部格式，优先使用非规范化字段（如果可用）
    const refs: UnresolvedRef[] = unresolvedRefs.map((ref) => ({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      column: ref.column,
      filePath: ref.filePath || this.getFilePathFromNodeId(ref.fromNodeId),
      language: ref.language || this.getLanguageFromNodeId(ref.fromNodeId),
    }));

    const total = refs.length;
    let lastReportedPercent = -1;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!; // Array index is guaranteed to be in bounds
      const result = this.resolveOne(ref);

      if (result) {
        resolved.push(result);
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1;
      } else {
        unresolved.push(ref);
      }

      // 每 1% 上报一次进度，避免更新过于频繁
      if (onProgress) {
        const currentPercent = Math.floor((i / total) * 100);
        if (currentPercent > lastReportedPercent) {
          lastReportedPercent = currentPercent;
          onProgress(i + 1, total);
        }
      }
    }

    // 最终进度上报
    if (onProgress && total > 0) {
      onProgress(total, total);
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    };
  }

  /**
   * 检查引用名称在代码库中是否有任何可能的匹配。
   * 使用预构建的 knownNames 集合，跳过对确实不存在的符号名称的昂贵解析。
   */
  private hasAnyPossibleMatch(name: string): boolean {
    if (!this.knownNames) return true; // 没有预过滤器可用

    // 直接名称匹配
    if (this.knownNames.has(name)) return true;

    // 对于 "obj.method" 或 "Class::method" 形式的限定名，检查各部分
    const dotIdx = name.indexOf('.');
    if (dotIdx > 0) {
      const receiver = name.substring(0, dotIdx);
      const member = name.substring(dotIdx + 1);
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
      // 同时检查首字母大写的接收者（实例方法解析）
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
      if (this.knownNames.has(capitalized)) return true;
      // JVM FQN：`com.example.foo.Bar` —— 唯一有用的片段是最后一段
      // (`Bar`)；前面的检查找到的 `example.foo.Bar` 永远不会匹配节点名称。
      const lastDot = name.lastIndexOf('.');
      if (lastDot > dotIdx) {
        const tail = name.substring(lastDot + 1);
        if (tail && this.knownNames.has(tail)) return true;
      }
    }
    const colonIdx = name.indexOf('::');
    if (colonIdx > 0) {
      const receiver = name.substring(0, colonIdx);
      const member = name.substring(colonIdx + 2);
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true;
      // 多段路径 `a::b::c`（Rust/C++ 模块调用如
      // `database::profiles::find`）—— 唯一命名符号的片段是最后一段（`c`）；
      // 上面的 `member` 是 `b::c`，永远不会匹配节点名称，
      // 若不处理，预过滤器会在 Rust 路径解析器看到它之前就将其丢弃。
      // 与上面的点号名称叶节点检查对称处理。
      const lastColon = name.lastIndexOf('::');
      if (lastColon > colonIdx) {
        const tail = name.substring(lastColon + 2);
        if (tail && this.knownNames.has(tail)) return true;
      }
    }

    // 对于路径形式的引用（如 "snippets/drawer-menu.liquid"），检查文件名部分
    const slashIdx = name.lastIndexOf('/');
    if (slashIdx > 0) {
      const fileName = name.substring(slashIdx + 1);
      if (this.knownNames.has(fileName)) return true;
    }

    return false;
  }

  /**
   * `ref.referenceName` 是否匹配其所在文件中声明的某个导入？
   * 用作预过滤的逃逸口，确保当名称在项目范围内没有声明时，
   * 重导出链解析仍有机会执行。
   */
  private matchesAnyImport(ref: UnresolvedRef): boolean {
    const imports = this.context.getImportMappings(ref.filePath, ref.language);
    if (imports.length === 0) return false;
    for (const imp of imports) {
      if (
        imp.localName === ref.referenceName ||
        ref.referenceName.startsWith(imp.localName + '.')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 解析单个引用
   */
  resolveOne(ref: UnresolvedRef): ResolvedRef | null {
    // 跳过内置/外部引用
    if (this.isBuiltInOrExternal(ref)) {
      return null;
    }

    // 快速预过滤：若代码库中不存在此名称的符号，
    // 且该名称不匹配本地导入，则跳过。导入逃逸是必要的，
    // 因为重导出重命名链（`import { login } from './barrel'`，
    // 桶文件中有 `export { signIn as login } from './auth'`）
    // 会刻意引用一个在任何地方都没有声明的名称——只有上游的重命名符号才有。
    if (
      !this.hasAnyPossibleMatch(ref.referenceName) &&
      !this.matchesAnyImport(ref) &&
      !this.frameworks.some((f) => f.claimsReference?.(ref.referenceName))
    ) {
      return null;
    }

    // 函数引用（#756）走专用的严格门控路径：
    // 先进行基于导入的解析（已导入的回调通过其导入解析，是最精确的跨文件信号），
    // 再用 matchFunctionRef（优先同文件，仅对唯一跨文件，目标限函数/方法）。
    // 这些引用不会进入下面的框架策略或模糊策略。
    if (ref.referenceKind === 'function_ref') {
      // `this.<成员>` 值（TS/JS）只针对封闭类的自有成员解析——
      // 绝不匹配其他位置的同名符号。
      if (ref.referenceName.startsWith('this.')) {
        return this.gateLanguage(this.resolveThisMemberFnRef(ref), ref);
      }
      const viaImport = this.gateLanguage(resolveViaImport(ref, this.context), ref);
      if (viaImport) {
        const target = this.queries.getNodeById(viaImport.targetNodeId);
        if (target && (target.kind === 'function' || target.kind === 'method')) {
          return viaImport;
        }
      }
      return this.gateLanguage(matchFunctionRef(ref, this.context), ref);
    }

    // JVM FQN 导入跳过框架/名称匹配器：`import com.example.Bar`
    // 直接通过 qualifiedName 索引解析，即使不同包中存在多个 `Bar` 类，
    // 该索引也是无歧义的。
    const jvmImport = resolveJvmImport(ref, this.context);
    if (jvmImport) return jvmImport;

    // Razor/Blazor：标记或 `@code` 中的类型引用通过文件的 `@using`
    // 命名空间（含文件夹 `_Imports.razor`）解析。这能精确地消歧一个在多个命名空间
    // 中存在的简单名称——例如将 `CatalogBrand` 解析为
    // `BlazorShared.Models::CatalogBrand`（该 DTO 由 `.razor` 的 `@using` 引入），
    // 而不是同名的领域实体。
    if (ref.language === 'razor') {
      const razorResult = this.resolveRazorUsing(ref);
      if (razorResult) return razorResult;
    }

    const candidates: ResolvedRef[] = [];

    // 策略 1：尝试框架专属解析。跨语言桥接故意保留
    // （Drupal `routing.yml` → PHP 控制器，RN JS → 原生 `calls`）——
    // `gateFrameworkLanguage` 只丢弃两个已知语言族之间的类型/导入边，
    // 不会丢弃 `calls` 桥接或 config↔code 边。
    for (const framework of this.frameworks) {
      const result = this.gateFrameworkLanguage(framework.resolve(ref, this.context), ref);
      if (result) {
        if (result.confidence >= 0.9) return result; // 高置信度，直接返回
        candidates.push(result);
      }
    }

    // 策略 2：尝试基于导入的解析
    const importResult = this.gateLanguage(resolveViaImport(ref, this.context), ref);
    if (importResult) {
      if (importResult.confidence >= 0.9) return importResult;
      candidates.push(importResult);
    }

    // PHP include/require 路径只通过导入解析定位到文件。
    // 若导入解析未找到文件，则不能回退到符号名称匹配器——
    // 那样会错误地将 "inc/db.php" 连接到树中其他无关的 db.php
    // （错误的边比没有边更糟，#660）。
    if (isPhpIncludePathRef(ref)) {
      return candidates.length > 0
        ? candidates.reduce((best, curr) =>
            curr.confidence > best.confidence ? curr : best
          )
        : null;
    }

    // 策略 3：尝试名称匹配
    const nameResult = this.gateLanguage(matchReference(ref, this.context), ref);
    if (nameResult) {
      candidates.push(nameResult);
    }

    if (candidates.length === 0) {
      // 将第一遍无法解析的链式静态工厂/流式调用推迟处理——
      // 其方法可能定义在接收者所符合的超类型上，
      // 待 implements/extends 边建立后（一致性遍）即可解析。
      if (
        ref.referenceKind === 'calls' &&
        CHAIN_LANGUAGES.has(ref.language) &&
        CHAIN_SHAPE.test(ref.referenceName)
      ) {
        this.deferredChainRefs.push(ref);
      }
      return null;
    }

    // 返回置信度最高的候选项
    return candidates.reduce((best, curr) =>
      curr.confidence > best.confidence ? curr : best
    );
  }

  /**
   * 从已解析的引用创建边
   */
  createEdges(resolved: ResolvedRef[]): Edge[] {
    return resolved.map((ref) => {
      // `function_ref`（#756）仅供内部使用：持久化为 `references` 边
      // （注册位置取决于回调），可通过 metadata.resolvedBy === 'function-ref' 区分。
      // callers/impact 已遍历 `references`，因此注册位置无需修改图层即可呈现。
      let kind: Edge['kind'] =
        ref.original.referenceKind === 'function_ref' ? 'references' : ref.original.referenceKind;

      // 当类/结构体的目标是接口时，将 "extends" 提升为 "implements"
      if (kind === 'extends') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (targetNode && (targetNode.kind === 'interface' || targetNode.kind === 'protocol')) {
          const sourceNode = this.queries.getNodeById(ref.original.fromNodeId);
          if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
            kind = 'implements';
          }
        }
      }

      // 当解析目标是类/结构体时，将 "calls" 提升为 "instantiates"。
      // 没有 `new` 关键字的语言（Python、Ruby）将实例化表达为 `Foo()`——
      // 提取器在没有符号信息时无法将其与函数调用区分，
      // 但解析器可以：若 `Foo` 解析为一个类，则该调用确实是实例化。
      if (kind === 'calls') {
        const targetNode = this.queries.getNodeById(ref.targetNodeId);
        if (targetNode && (targetNode.kind === 'class' || targetNode.kind === 'struct')) {
          kind = 'instantiates';
        }
      }

      return {
        source: ref.original.fromNodeId,
        target: ref.targetNodeId,
        kind,
        line: ref.original.line,
        column: ref.original.column,
        metadata: {
          confidence: ref.confidence,
          resolvedBy: ref.resolvedBy,
          // 函数引用边（#756）的统一标记，不论由哪种策略解析
          // （导入 vs matchFunctionRef）——让工具能标注"回调注册"，
          // 也让验证精确对比该功能新增的边。
          ...(ref.original.referenceKind === 'function_ref' ? { fnRef: true } : {}),
        },
      };
    });
  }

  /**
   * 解析引用并将边持久化到数据库
   */
  resolveAndPersist(
    unresolvedRefs: UnresolvedReference[],
    onProgress?: (current: number, total: number) => void
  ): ResolutionResult {
    const result = this.resolveAll(unresolvedRefs, onProgress);

    // 从已解析的引用创建边
    const edges = this.createEdges(result.resolved);

    // 将边插入数据库
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
    }

    // 从 unresolved_refs 表中清理已解析的引用，确保指标准确
    if (result.resolved.length > 0) {
      this.queries.deleteSpecificResolvedReferences(
        result.resolved.map((r) => ({
          fromNodeId: r.original.fromNodeId,
          referenceName: r.original.referenceName,
          referenceKind: r.original.referenceKind,
        }))
      );
    }

    return result;
  }

  /**
   * 对链式静态工厂/流式调用的第二遍解析——这些调用的链式方法定义在接收者类型
   * 所符合的超类型上（协议扩展/继承/默认接口方法，#750）。第一遍无法解析，
   * 因为 `implements`/`extends` 边尚未建立；本方法在边持久化之后运行，
   * 因此 `context.getSupertypes`（以及 resolveMethodOnType 中的一致性回退）
   * 可以遍历这些边。
   *
   * 仅对 `inner().method` 链式形式且属于点号链语言的剩余未解析引用操作——
   * 数量较少——且是幂等的（重复解析已解析的引用是空操作，因为它已被删除）。
   * 返回新创建的边数。
   */
  resolveChainedCallsViaConformance(): number {
    const deferred = this.deferredChainRefs;
    this.deferredChainRefs = [];
    if (deferred.length === 0) return 0;

    // 读取最新的边（主遍在这些引用被推迟后构建了 implements/extends 边）。
    // matchDottedCallChain 现在可以通过 context.getSupertypes ->
    // resolveMethodOnType 的一致性遍历，解析超类型上的方法。
    this.clearCaches();
    const resolved: ResolvedRef[] = [];
    for (const ref of deferred) {
      // `::` 接收者语言（Rust）使用 `::` 分割（matchScopedCallChain）；
      // 点号接收者语言使用 `.` 分割（matchDottedCallChain）。
      const chainMatch = SCOPED_CHAIN_LANGUAGES.has(ref.language)
        ? matchScopedCallChain(ref, this.context)
        : matchDottedCallChain(ref, this.context);
      const match = this.gateLanguage(chainMatch, ref);
      if (match) resolved.push(match);
    }
    if (resolved.length === 0) return 0;

    const edges = this.createEdges(resolved);
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
      this.clearCaches();
    }
    return edges.length;
  }

  /**
   * 分批解析并持久化，以保持内存有界。
   * 分块处理未解析的引用，每批次后持久化边并清理已解析的引用，
   * 避免积累大型数组。
   */
  async resolveAndPersistBatched(
    onProgress?: (current: number, total: number) => void,
    batchSize: number = 5000
  ): Promise<ResolutionResult> {
    this.warmCaches();

    const total = this.queries.getUnresolvedReferencesCount();
    let processed = 0;
    const aggregateStats = {
      total: 0,
      resolved: 0,
      unresolved: 0,
      byMethod: {} as Record<string, number>,
    };

    // 分批处理。每批次删除已解析的引用后，始终从偏移量 0 读取，
    // 剩余行会向前移动。
    let prevRemaining = Number.POSITIVE_INFINITY;
    while (true) {
      const batch = this.queries.getUnresolvedReferencesBatch(0, batchSize);
      if (batch.length === 0) break;

      const result = this.resolveAll(batch);

      // 立即持久化边
      const edges = this.createEdges(result.resolved);
      if (edges.length > 0) {
        this.queries.insertEdges(edges);
      }

      // 清理已解析的引用，避免它们出现在下一批次中
      if (result.resolved.length > 0) {
        this.queries.deleteSpecificResolvedReferences(
          result.resolved.map((r) => ({
            fromNodeId: r.original.fromNodeId,
            referenceName: r.original.referenceName,
            referenceKind: r.original.referenceKind,
          }))
        );
      }

      // 从数据库删除本批次无法解析的引用，避免重复处理
      if (result.unresolved.length > 0) {
        this.queries.deleteSpecificResolvedReferences(
          result.unresolved.map((r) => ({
            fromNodeId: r.fromNodeId,
            referenceName: r.referenceName,
            referenceKind: r.referenceKind,
          }))
        );
      }

      // 汇总统计数据
      aggregateStats.total += result.stats.total;
      aggregateStats.resolved += result.stats.resolved;
      aggregateStats.unresolved += result.stats.unresolved;
      for (const [method, count] of Object.entries(result.stats.byMethod)) {
        aggregateStats.byMethod[method] = (aggregateStats.byMethod[method] || 0) + count;
      }

      processed += batch.length;
      onProgress?.(processed, total);

      // 让出执行权，使进度 UI 能在批次间渲染
      await new Promise(resolve => setImmediate(resolve));

      // 若本批次既未解析也未移除任何内容，则会在相同行上无限循环。
      // 中断以避免无限循环。
      if (result.resolved.length === 0 && result.unresolved.length === batch.length) {
        break;
      }

      // 非进度保护（纵深防御）。由于每次从偏移量 0 重新读取，
      // unresolved_refs 表必须在每次迭代中缩小——上面已删除已解析和未解析的引用。
      // 若未缩小，说明某个解析器返回了匹配项，但其 `original.referenceName`
      // 与存储的行不同，导致键删除无效，同一批行会被反复读取、解析和插入
      // （这正是在 99 文件代码库上产生 500 万条边 / 1.4 GB 的 Go 回退修复前的失控情况）。
      // 停止，而不是无限制地扩张图。
      const remaining = this.queries.getUnresolvedReferencesCount();
      if (remaining >= prevRemaining) break;
      prevRemaining = remaining;
    }

    // 动态边合成：所有基础 `calls` 边持久化后，
    // 合成静态解析遗漏的观察者/回调分发边（调度器 → 已注册的回调）。
    // 尽力而为——绝不因此让索引失败。
    // 参见 docs/design/callback-edge-synthesis.md。
    try {
      aggregateStats.byMethod['callback-synthesis'] = synthesizeCallbackEdges(this.queries, this.context);
    } catch {
      // 合成是增量可选的；忽略失败
    }

    return {
      resolved: [],
      unresolved: [],
      stats: aggregateStats,
    };
  }

  /**
   * 获取已检测到的框架
   */
  getDetectedFrameworks(): string[] {
    return this.frameworks.map((f) => f.name);
  }

  /**
   * 检查引用是否指向内置或外部符号
   */
  private isBuiltInOrExternal(ref: UnresolvedRef): boolean {
    const name = ref.referenceName;
    const isJsTs = ref.language === 'typescript' || ref.language === 'javascript'
      || ref.language === 'tsx' || ref.language === 'jsx';

    // JavaScript/TypeScript 内置符号
    if (isJsTs && JS_BUILT_INS.has(name)) {
      return true;
    }

    // 常见的 JS/TS 库调用（console.log、Math.floor、JSON.parse）
    if (isJsTs && (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.'))) {
      return true;
    }

    // React 自身提供的 hooks
    if (isJsTs && REACT_HOOKS.has(name)) {
      return true;
    }

    // Python 内置函数（仅裸调用——console.print 等点号调用是方法调用）
    if (ref.language === 'python' && PYTHON_BUILT_INS.has(name)) {
      return true;
    }

    // Python 内置方法调用（如 list.extend、dict.update）
    if (ref.language === 'python') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const receiver = name.substring(0, dotIdx);
        const method = name.substring(dotIdx + 1);
        // 过滤内置类型上的调用（list.append、dict.update 等）
        if (PYTHON_BUILT_IN_TYPES.has(receiver)) {
          return true;
        }
        // 过滤非类接收者上的内置方法
        // （如 items.append，其中 items 是一个局部列表变量）
        // 但若首字母大写的接收者匹配代码库中已知的类，则保留
        if (PYTHON_BUILT_IN_METHODS.has(method)) {
          const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
          if (!this.knownNames?.has(capitalized)) {
            return true;
          }
        }
      }
      // 与内置方法名冲突的裸名（index、get、update、count……）
      // 只有在代码库中完全没有声明时才视为内置。若有同名符号——
      // 如 Flask/FastAPI 视图 `def index()` 或 `def get()`——
      // 则是真实的引用目标。与上面点号分支上的 knownNames 保护对称；
      // 若无此保护，每个以内置方法名命名的处理器都会悄无声息地丢失其路由→处理器边。
      if (PYTHON_BUILT_IN_METHODS.has(name) && !this.knownNames?.has(name)) {
        return true;
      }
    }

    // Go 标准库包——如 "fmt.Println"、"http.ListenAndServe" 等形式的引用
    if (ref.language === 'go') {
      const dotIdx = name.indexOf('.');
      if (dotIdx > 0) {
        const pkg = name.substring(0, dotIdx);
        if (GO_STDLIB_PACKAGES.has(pkg)) {
          return true;
        }
      }
      if (GO_BUILT_INS.has(name)) {
        return true;
      }
    }

    // Pascal/Delphi 内置符号和标准库单元
    if (ref.language === 'pascal') {
      if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p))) {
        return true;
      }
      if (PASCAL_BUILT_INS.has(name)) {
        return true;
      }
    }

    // C/C++ 标准库符号（printf、malloc、std::vector 等）。
    // 与用户定义符号冲突的名称不会被过滤——C 和 C++ 项目经常遮蔽标准库名称
    // （自定义分配器定义 `malloc`/`free`，流封装器定义 `read`/`write`/`open`，
    // 容器定义 `move`/`swap`，日志库封装 `printf`）。
    // 杀死那些解析会让图变错，而不是更干净。我们只在用户没有定义该名称的节点时过滤——
    // 此时名称匹配无论如何都不会产生边，过滤只是短路了工作。
    if (ref.language === 'c' || ref.language === 'cpp') {
      // C++ std:: 命名空间前缀——可无条件过滤，
      // 因为 `std::foo` 在 tree-sitter 输出中绝不会是用户定义的限定名。
      if (name.startsWith('std::')) return true;
      if (C_BUILT_INS.has(name) || CPP_BUILT_INS.has(name)) {
        return !this.hasAnyPossibleMatch(name);
      }
    }

    return false;
  }

  /**
   * 从节点 ID 获取文件路径
   */
  private getFilePathFromNodeId(nodeId: string): string {
    const node = this.queries.getNodeById(nodeId);
    return node?.filePath || '';
  }

  /**
   * 从节点 ID 获取语言
   */
  private getLanguageFromNodeId(nodeId: string): UnresolvedRef['language'] {
    const node = this.queries.getNodeById(nodeId);
    return node?.language || 'unknown';
  }

  /**
   * 丢弃跨语言族的导入/名称匹配策略解析结果。
   * 两种模式（对应 `applyLanguageGate` 的候选过滤）：
   *  - `references`（类型用法）：严格——`Type.member` 静态读取的是同族类型，
   *    绝不是另一语言中碰巧同名的符号。丢弃所有非同族目标。
   *  - `imports`（导入绑定 / `#include`）：两端已知——C++ 的 `#include "X.h"`
   *    不能解析为另一平台上同名的 ObjC 头文件（基本名冲突），
   *    但单一族/SFC 语言（`vue` → `.ts`）的跨族导入不受影响。
   * 适用于导入（策略 2）+ 名称匹配（策略 3）的结果。
   */
  /**
   * 收集 `.razor`/`.cshtml` 文件作用域内的 `@using` 命名空间：
   * 文件自身的 `@using` 指令，加上从文件所在文件夹到项目根目录逐级级联的
   * `_Imports.razor`（Razor `_Imports` 级联机制）。按文件缓存。
   */
  private getRazorUsings(filePath: string): string[] {
    const cached = this.razorUsingsCache.get(filePath);
    if (cached) return cached;
    const usings = new Set<string>();
    const addFrom = (src: string | null): void => {
      if (!src) return;
      for (const m of src.matchAll(/^\s*@using\s+(?:static\s+)?([A-Za-z_][\w.]*)/gm)) usings.add(m[1]!);
    };
    addFrom(this.context.readFile(filePath));
    let dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    // 向上遍历到项目根目录，读取每一层的 _Imports.razor。
    for (;;) {
      addFrom(this.context.readFile(dir ? `${dir}/_Imports.razor` : '_Imports.razor'));
      if (!dir) break;
      const slash = dir.lastIndexOf('/');
      dir = slash >= 0 ? dir.slice(0, slash) : '';
    }
    const arr = [...usings];
    this.razorUsingsCache.set(filePath, arr);
    return arr;
  }

  /**
   * 通过文件的 `@using` 命名空间解析 Razor/Blazor 中的简单类型引用：
   * `CatalogBrand` + `@using BlazorShared.Models` → 限定名为
   * `BlazorShared.Models::CatalogBrand` 的节点。
   * 只有当 `@using` 集合恰好产生唯一一个类型时才解析
   * （否则仍然有歧义，回退到名称匹配）。
   */
  private resolveRazorUsing(ref: UnresolvedRef): ResolvedRef | null {
    if (ref.referenceName.includes('.') || ref.referenceName.includes('::')) return null;
    const usings = this.getRazorUsings(ref.filePath);
    if (usings.length === 0) return null;
    const found = new Map<string, Node>();
    for (const ns of usings) {
      for (const cand of this.context.getNodesByQualifiedName(`${ns}::${ref.referenceName}`)) {
        found.set(cand.id, cand);
      }
    }
    if (found.size !== 1) return null;
    const target = found.values().next().value!;
    return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
  }

  /**
   * 将 `this.<成员>` 函数引用（#756/#808）解析到封闭类的自有成员——
   * 绝不匹配其他位置的同名符号。注册惯用法
   * （`btn.on('click', this.handleClick)`）命名的是正在定义的类的成员，
   * 因此唯一有效的目标与 from 符号共享限定名作用域。
   * 目标限函数/方法——属性（数据字段，#808 分类后）不产生边——
   * 要求同文件，不做任何形式的回退。
   */
  private resolveThisMemberFnRef(ref: UnresolvedRef): ResolvedRef | null {
    const member = ref.referenceName.slice('this.'.length);
    if (!member) return null;
    const fromNode = this.queries.getNodeById(ref.fromNodeId);
    if (!fromNode) return null;
    // 在类体级别声明的 hook（Ruby `before_action :authenticate`）
    // 归属于类节点本身——其限定名即作用域。
    // 对于成员，去掉成员片段。
    let classPrefix: string;
    if (SUPERTYPE_BEARING_KINDS.has(fromNode.kind) || fromNode.kind === 'module') {
      classPrefix = fromNode.qualifiedName;
    } else {
      const sep = fromNode.qualifiedName.lastIndexOf('::');
      if (sep <= 0) return null; // not inside a class scope
      classPrefix = fromNode.qualifiedName.slice(0, sep);
    }
    const candidates = this.context
      .getNodesByQualifiedName(`${classPrefix}::${member}`)
      .filter(
        (n) =>
          (n.kind === 'function' || n.kind === 'method') &&
          n.filePath === ref.filePath &&
          n.id !== ref.fromNodeId
      );
    if (candidates.length === 0) {
      // 不在类本身上——可能是继承而来。此遍中 implements/extends 边尚不存在，
      // 因此推迟到超类型遍（resolveDeferredThisMemberRefs）重试，而不是放弃。
      this.deferredThisMemberRefs.push(ref);
      return null;
    }
    const target = candidates.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.95,
      resolvedBy: 'function-ref',
    };
  }

  /**
   * 对封闭类本身未声明的 `this.<成员>` 引用的第二遍处理（#808）：
   * 待 implements/extends 边建立后，（有深度上限地）遍历类的超类型，
   * 在最近声明该成员的超类型上解析它——子类中注册的 `this.handleSubmit`
   * 解析为 `FormBase::handleSubmit`。只验证目标（函数/方法类型，同语言族）；
   * 无匹配则不产生边。
   * 生命周期与 resolveChainedCallsViaConformance 对称。返回新创建的边数。
   */
  resolveDeferredThisMemberRefs(): number {
    const deferred = this.deferredThisMemberRefs;
    this.deferredThisMemberRefs = [];
    if (deferred.length === 0) return 0;

    this.clearCaches();
    const resolved: ResolvedRef[] = [];
    for (const ref of deferred) {
      const member = ref.referenceName.slice('this.'.length);
      const fromNode = this.queries.getNodeById(ref.fromNodeId);
      if (!fromNode || !member) continue;
      // 类体级别的 hook（Ruby）归属于类节点本身。
      let className: string;
      if (SUPERTYPE_BEARING_KINDS.has(fromNode.kind) || fromNode.kind === 'module') {
        className = fromNode.name;
      } else {
        const sep = fromNode.qualifiedName.lastIndexOf('::');
        if (sep <= 0) continue;
        const classPrefix = fromNode.qualifiedName.slice(0, sep);
        className = classPrefix.includes('::')
          ? classPrefix.slice(classPrefix.lastIndexOf('::') + 2)
          : classPrefix;
      }

      // 节点锚定的 BFS 超类型图遍历：从引用所在文件中的类节点出发
      // （绝不匹配其他位置的同名类——rails 中有十几个 `Engine`），
      // 沿 implements/extends 边遍历到超类型节点，
      // 通过 `contains` 边查找成员。整个过程不做任何基于名称的合并——
      // 基于名称的 getSupertypes('Engine') 会合并每个 Engine 的父类，
      // 在 rails 上产生跨类的错误边。
      let frontierNodes = this.context
        .getNodesByName(className)
        .filter(
          (n) =>
            SUPERTYPE_BEARING_KINDS.has(n.kind) &&
            n.filePath === ref.filePath
        );
      if (frontierNodes.length === 0) {
        // 类本身可能声明在另一个文件中（partial/reopened 类）；
        // 回退到同族的同名节点。
        frontierNodes = this.context
          .getNodesByName(className)
          .filter(
            (n) =>
              SUPERTYPE_BEARING_KINDS.has(n.kind) &&
              sameLanguageFamily(n.language, ref.language)
          );
      }
      const seenNodes = new Set<string>(frontierNodes.map((n) => n.id));
      let target: Node | null = null;
      for (let depth = 0; depth < 5 && frontierNodes.length > 0 && !target; depth++) {
        const next: Node[] = [];
        for (const typeNode of frontierNodes) {
          for (const edge of this.queries.getOutgoingEdges(typeNode.id, ['implements', 'extends'])) {
            const superNode = this.queries.getNodeById(edge.target);
            if (!superNode || seenNodes.has(superNode.id)) continue;
            seenNodes.add(superNode.id);
            if (!SUPERTYPE_BEARING_KINDS.has(superNode.kind)) continue;
            // 通过超类型的 contains 边进行成员查找。
            for (const c of this.queries.getOutgoingEdges(superNode.id, ['contains'])) {
              const m = this.queries.getNodeById(c.target);
              if (
                m &&
                m.name === member &&
                (m.kind === 'function' || m.kind === 'method') &&
                sameLanguageFamily(m.language, ref.language)
              ) {
                target = m;
                break;
              }
            }
            if (target) break;
            next.push(superNode);
          }
          if (target) break;
        }
        frontierNodes = next;
      }

      if (target) {
        resolved.push({
          original: ref,
          targetNodeId: target.id,
          confidence: 0.85,
          resolvedBy: 'function-ref',
        });
      }
    }
    if (resolved.length === 0) return 0;

    const edges = this.createEdges(resolved);
    if (edges.length > 0) {
      this.queries.insertEdges(edges);
      this.clearCaches();
    }
    return edges.length;
  }

  private gateLanguage(result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
    if (!result) return result;
    const tgt = this.getLanguageFromNodeId(result.targetNodeId);
    if (!tgt || !ref.language) return result;
    if ((ref.referenceKind === 'references' || ref.referenceKind === 'function_ref') && !sameLanguageFamily(tgt, ref.language)) return null;
    if (ref.referenceKind === 'imports' && crossesKnownFamily(tgt, ref.language)) return null;
    return result;
  }

  /**
   * 丢弃框架策略中跨越两个已知语言族的 `references` 或 `imports` 边。
   * 框架策略对跨语言桥接故意不设门控，但合法的桥接要么是 `calls` 边
   * （RN/Expo JS → 原生），要么是 config↔code 边，其 config 侧
   * （`yaml`/`blade`/……）不属于已知的编程语言族。
   * 两个已知语言族之间的 `references`/`imports` 边始终是偶然的名称冲突——
   * React/Svelte/Vue PascalCase 组件解析器通过 `getNodesByName` 匹配，
   * 没有语言检查，导致 TS 的 `<TestRunner>` 引用愉快地匹配了 Kotlin 的
   * `class TestRunner`。只门控两端均为已知跨族的情况，
   * 可让 config 桥接和 `calls` 桥接不受影响地通过。
   */
  private gateFrameworkLanguage(result: ResolvedRef | null, ref: UnresolvedRef): ResolvedRef | null {
    if (!result) return result;
    if (ref.referenceKind !== 'references' && ref.referenceKind !== 'imports') return result;
    const tgt = this.getLanguageFromNodeId(result.targetNodeId);
    if (tgt && ref.language && crossesKnownFamily(tgt, ref.language)) return null;
    return result;
  }
}

/**
 * 创建引用解析器实例
 */
export function createResolver(projectRoot: string, queries: QueryBuilder): ReferenceResolver {
  const resolver = new ReferenceResolver(projectRoot, queries);
  resolver.initialize();
  return resolver;
}
