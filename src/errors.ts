/**
 * Synapse 错误类
 *
 * 用于更好地进行错误处理和调试的自定义错误类型。
 *
 * @module errors
 *
 * @example
 * ```typescript
 * import { FileError, ParseError, setLogger, silentLogger } from 'synapse';
 *
 * // 捕获特定错误类型
 * try {
 *   await cg.indexAll();
 * } catch (error) {
 *   if (error instanceof FileError) {
 *     console.log(`File error at ${error.filePath}: ${error.message}`);
 *   } else if (error instanceof ParseError) {
 *     console.log(`Parse error at ${error.filePath}:${error.line}`);
 *   }
 * }
 *
 * // 在测试中禁用日志
 * setLogger(silentLogger);
 * ```
 */

/**
 * 所有 Synapse 错误的基类。
 *
 * 所有 Synapse 特定错误均继承此类，允许通过单个 catch 块捕获所有 Synapse 错误。
 *
 * @example
 * ```typescript
 * try {
 *   await cg.indexAll();
 * } catch (error) {
 *   if (error instanceof SynapseError) {
 *     console.log(`Synapse error [${error.code}]: ${error.message}`);
 *   }
 * }
 * ```
 */
export class SynapseError extends Error {
  /** 用于分类的错误码（如 'FILE_ERROR'、'PARSE_ERROR'）*/
  readonly code: string;
  /** 关于错误的附加上下文信息 */
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'SynapseError';
    this.code = code;
    this.context = context;

    // 为 V8 保留正确的栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * 读取或访问文件时的错误
 */
export class FileError extends SynapseError {
  readonly filePath: string;

  constructor(message: string, filePath: string, cause?: Error) {
    super(message, 'FILE_ERROR', { filePath, cause: cause?.message });
    this.name = 'FileError';
    this.filePath = filePath;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * 解析源代码时的错误
 */
export class ParseError extends SynapseError {
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;

  constructor(
    message: string,
    filePath: string,
    options?: { line?: number; column?: number; cause?: Error }
  ) {
    super(message, 'PARSE_ERROR', {
      filePath,
      line: options?.line,
      column: options?.column,
      cause: options?.cause?.message,
    });
    this.name = 'ParseError';
    this.filePath = filePath;
    this.line = options?.line;
    this.column = options?.column;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

/**
 * 数据库操作时的错误
 */
export class DatabaseError extends SynapseError {
  readonly operation: string;

  constructor(message: string, operation: string, cause?: Error) {
    super(message, 'DATABASE_ERROR', { operation, cause: cause?.message });
    this.name = 'DatabaseError';
    this.operation = operation;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * 搜索操作时的错误
 */
export class SearchError extends SynapseError {
  readonly query: string;

  constructor(message: string, query: string, cause?: Error) {
    super(message, 'SEARCH_ERROR', { query, cause: cause?.message });
    this.name = 'SearchError';
    this.query = query;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * 向量/嵌入操作时的错误
 */
export class VectorError extends SynapseError {
  constructor(message: string, operation: string, cause?: Error) {
    super(message, 'VECTOR_ERROR', { operation, cause: cause?.message });
    this.name = 'VectorError';
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * 配置相关错误
 */
export class ConfigError extends SynapseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigError';
  }
}

/**
 * Synapse 操作的简单日志接口
 *
 * 默认将警告记录到 console.warn，将错误记录到 console.error。
 * 可配置为使用自定义日志实现。
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * 默认的基于 console 的日志器
 */
export const defaultLogger: Logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (process.env.SYNAPSE_DEBUG) {
      console.debug(`[Synapse] ${message}`, context ?? '');
    }
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[Synapse] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[Synapse] ${message}`, context ?? '');
  },
};

/**
 * 静默日志器（无输出）——适用于测试
 */
export const silentLogger: Logger = {
  debug(): void {},
  warn(): void {},
  error(): void {},
};

/**
 * 当前日志器实例（可替换）
 */
let currentLogger: Logger = defaultLogger;

/**
 * 设置全局日志器
 */
export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

/**
 * 获取当前日志器
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * 记录调试消息
 */
export function logDebug(message: string, context?: Record<string, unknown>): void {
  currentLogger.debug(message, context);
}

/**
 * 记录警告消息
 */
export function logWarn(message: string, context?: Record<string, unknown>): void {
  currentLogger.warn(message, context);
}

/**
 * 记录错误消息
 */
export function logError(message: string, context?: Record<string, unknown>): void {
  currentLogger.error(message, context);
}
