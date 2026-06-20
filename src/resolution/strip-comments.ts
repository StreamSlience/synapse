/**
 * 面向框架路由提取器的逐语言注释剥离器。
 *
 * 将注释字符及字符串字面量内容（这些内容可能隐藏路由相关文本）替换为空格
 * （而非删除），以保留源码偏移量。这意味着在剥离后的输出上执行正则匹配时，
 * `match.index` 仍能对应原始源码中的同一行。
 *
 * 示例：
 *   输入：  "x = 1  # path('/fake/', V)\n real = 2"
 *   输出：  "x = 1                       \n real = 2"
 *
 * 为何同时剥离字符串/文档字符串和注释？Python 模块/类的文档字符串是常见的
 * 误报来源——它们的使用说明中往往包含 `path('/example/', View)` 这样的示例。
 * 我们将三引号字符串与注释同等处理。单行字符串保持不变（Python 字符串内的
 * `#` 不是注释）。
 *
 * 范围：这是一个务实的、支持正则的辅助工具，并非完整的解析器。
 * 它不尝试检测 JavaScript 正则字面量、Python f-string 表达式或
 * shell 风格的 heredoc。这些边界情况对于框架提取器所扫描的
 * `path(...)`、`Route::get(...)`、`app.get(...)` 类模式来说并不关键。
 */

export type CommentLang =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'php'
  | 'ruby'
  | 'java'
  | 'csharp'
  | 'swift'
  | 'go'
  | 'rust';

export function stripCommentsForRegex(content: string, lang: CommentLang): string {
  switch (lang) {
    case 'python':
      return stripPython(content);
    case 'ruby':
      return stripRuby(content);
    case 'rust':
      return stripRust(content);
    case 'php':
      return stripPhp(content);
    case 'go':
      return stripGo(content);
    case 'javascript':
    case 'typescript':
    case 'java':
    case 'csharp':
    case 'swift':
      return stripCStyle(content, /* allowSingleQuoteStrings */ lang === 'javascript' || lang === 'typescript');
    default:
      return content;
  }
}

/**
 * 将缓冲区中某个范围内的每个字符替换为空格，但保留换行符，
 * 以确保下游计算的行号仍然有效。
 */
function blankRange(buf: string[], start: number, end: number, src: string): void {
  for (let i = start; i < end; i++) {
    buf[i] = src[i] === '\n' ? '\n' : ' ';
  }
}

// ---------- Python ----------

function stripPython(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';
    const c3 = src[i + 2] ?? '';

    // 三引号字符串："""...""" 或 '''...'''
    if ((c === '"' || c === "'") && c2 === c && c3 === c) {
      const quote = c;
      const start = i;
      i += 3;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === quote && src[i + 1] === quote && src[i + 2] === quote) {
          i += 3;
          break;
        }
        i++;
      }
      blankRange(out, start, i, src);
      continue;
    }

    // 单行字符串：'...' 或 "..."
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break; // 字符串未终止
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }

    // 行注释
    if (c === '#') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Ruby ----------

function stripRuby(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  let atLineStart = true;

  while (i < n) {
    const c = src[i]!;

    // =begin / =end 块注释必须位于行首（允许前置可选空白）
    if (atLineStart && c === '=' && src.startsWith('=begin', i)) {
      const start = i;
      // consume to matching =end at line start
      i += '=begin'.length;
      while (i < n) {
        if (src[i] === '\n') {
          // 检查下一行是否为 =end
          let j = i + 1;
          while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
          if (src.startsWith('=end', j)) {
            i = j + '=end'.length;
            // consume rest of that line
            while (i < n && src[i] !== '\n') i++;
            break;
          }
        }
        i++;
      }
      blankRange(out, start, i, src);
      atLineStart = i > 0 && src[i - 1] === '\n';
      continue;
    }

    // 字符串字面量
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === quote) i++;
      atLineStart = false;
      continue;
    }

    // 行注释
    if (c === '#') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      atLineStart = false;
      continue;
    }

    if (c === '\n') {
      atLineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      // 空白字符不改变 atLineStart 状态
      i++;
      continue;
    }
    atLineStart = false;
    i++;
  }

  return out.join('');
}

// ---------- C-style (JS/TS/Java/C#/Swift) ----------

function stripCStyle(src: string, allowSingleQuoteStrings: boolean): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // 块注释
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < n) i += 2;
      blankRange(out, start, i, src);
      continue;
    }

    // 行注释
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // 字符串字面量
    if (c === '"' || (allowSingleQuoteStrings && c === "'") || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        // 模板字面量可以跨行；普通字符串在遇到换行时视为未终止
        if (quote !== '`' && src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- PHP ----------

function stripPhp(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // 块注释
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < n) i += 2;
      blankRange(out, start, i, src);
      continue;
    }

    // // 行注释
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // # 行注释（PHP 同时支持两种风格）
    if (c === '#') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // 字符串字面量：'、"、`（PHP 实际上不用反引号作字符串，
    // 但它有 shell 执行反引号；这里当作字符串处理即可）
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Go ----------

function stripGo(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // 块注释
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < n) i += 2;
      blankRange(out, start, i, src);
      continue;
    }

    // 行注释
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // 反引号原始字符串（无转义，可跨行）
    if (c === '`') {
      i++;
      while (i < n && src[i] !== '`') i++;
      if (i < n) i++;
      continue;
    }

    // 双引号解释型字符串
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === '"') i++;
      continue;
    }

    // 单引号 rune 字面量——简化处理：跳过 'x' 或 '\x'
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === "'") i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Rust ----------

function stripRust(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // 嵌套块注释 /* ... /* ... */ ... */
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      blankRange(out, start, i, src);
      continue;
    }

    // 行注释
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // 字符串字面量
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < n && src[i] === '"') i++;
      continue;
    }

    // 字符字面量——简化处理：跳过 'x' 或 '\x'
    if (c === "'") {
      // 可能是生命周期标注，例如 'a，但其中不含路由文本
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === "'") i++;
      continue;
    }

    i++;
  }

  return out.join('');
}
