/**
 * `synapse_explore` 的动态分发边界检测（#687）。
 *
 * 当智能体请求的流程在静态层面无法连通时，原因几乎总是动态分发点：
 * 计算型成员调用、getattr、反射、字符串键总线、类型化命令/中介者分发。
 * 猜测缺失的边被明确拒绝（沉默胜于错误 — 错误的边会污染地图并让智能体习得放弃行为）。
 * 取而代之，explore 诚实地"宣告"边界：静态路径终止的精确位置、分发形式，
 * 以及——当键在静态层面可见时（字符串字面量、`:symbol`、`new Type`）——
 * 该键，以便调用方可以缩短候选目标列表。
 *
 * 检测仅在查询时对智能体命名符号的注释/字符串去除后的函数体执行确定性正则匹配。
 * 图谱从不发生变更；未断裂的流程永远不会触发扫描。匹配在去除后的文本上运行
 * （防止注释或字符串内的代码误触发），但代码片段和键从相同偏移处的*原始*源码切取 —
 * 两个去除器均以原地替换空格的方式保留偏移量，正是为了实现这一点。
 * （`stripCommentsForRegex` 去除注释但刻意*保留*字符串内容 — 框架提取器需要路由字面量；
 * 而此处字符串内的分发形式属于误报，故 {@link blankStringContents} 也会将其清空，
 * 引号保留。）
 */
import { stripCommentsForRegex, type CommentLang } from '../resolution/strip-comments';

export interface BoundaryMatch {
  /** 稳定的形式 id，例如 'computed-call' — 用于按形式去重。 */
  form: string;
  /** 分发形式的可读标签，例如 'computed member call'。 */
  label: string;
  /** 该位置的单行源码片段（来自原始未裁剪的文本）。 */
  snippet: string;
  /** 被扫描函数体在其*文件*中的 1-based 行号（绝对行号，可直接打印）。 */
  line: number;
  /**
   * 静态可见的分发键（若存在）：`handlers['save']` 中的字符串字面量、
   * ruby `send` 中的 `:symbol`、`Send(new CreateCmd(...))` 中的类型名。
   * 用于驱动候选目标查找。键为运行时值（变量、计算表达式）时为 undefined。
   */
  key?: string;
  /** 对于类型化总线匹配，键是一个类型名（候选项 ~ `${key}Handler`）。 */
  keyIsType?: boolean;
  /** 同一函数体中相同 form+key 超出已报告的额外站点数。 */
  moreSites?: number;
}

interface FormSpec {
  form: string;
  label: string;
  /** 此形式适用的语言；undefined 表示所有语言。Node.language 的值。 */
  langs?: Set<string>;
  re: RegExp;
  /**
   * 从匹配项周围的*原始源码*片段（匹配起始..匹配结束 + keyWindow）中推导分发键。
   * 无静态键时返回 undefined。
   */
  keyFrom?: (orig: string) => { key: string; keyIsType?: boolean } | undefined;
  /**
   * 匹配结束后传给 keyFrom 的额外原始字符数，以第一个换行符为上限 —
   * 用于键位于匹配前缀之后的形式，例如 `.getMethod(` → `"handlePing"`。
   * 使用 $-锚定 keyFrom 正则的形式必须不设此项（锚定依赖切片在匹配处结束）。
   */
  keyWindow?: number;
}

const JS_FAMILY = new Set(['typescript', 'javascript', 'tsx', 'jsx', 'vue', 'svelte', 'astro']);
const PY = new Set(['python']);
const RB = new Set(['ruby']);
const PHP = new Set(['php']);
const JVM_CS_GO = new Set(['java', 'kotlin', 'scala', 'csharp', 'go']);
const SWIFT_OBJC = new Set(['swift', 'objc', 'objcpp', 'objective-c']);

/** 恰好一个带引号的字面量且无拼接 → 该字面量即为键。 */
function singleStringLiteral(text: string): string | undefined {
  const m = text.match(/^[^'"`]*(['"`])([\w.:-]{2,64})\1[^'"`]*$/);
  return m ? m[2] : undefined;
}

const FORMS: FormSpec[] = [
  {
    // handlers[action.type](payload) / registry[key](args) / table[k](...) —
    // `](`相邻是门控条件；`[`前必须是单词字符/`)`/`]`，
    // 以防止数组字面量和散文中的 markdown 格式误触发。
    form: 'computed-call',
    label: 'computed member call',
    re: /[\w$)\]]\s*\[([^[\]\n]{1,80})\]\s*\(/g,
    keyFrom: (orig) => {
      const inner = orig.match(/\[([^[\]\n]{1,80})\]\s*\($/);
      const key = inner ? singleStringLiteral(inner[1]!) : undefined;
      return key ? { key } : undefined;
    },
  },
  {
    // import(expr) / require(expr) 的参数为*非字面量*时 → 运行时模块选择。
    // 字面量导入是普通边，永远不会到达此扫描器。
    form: 'dynamic-import',
    label: 'dynamic import',
    langs: JS_FAMILY,
    re: /\b(?:import|require)\s*\(\s*(?![\s'"`)])/g,
  },
  {
    form: 'dynamic-import',
    label: 'dynamic import',
    langs: PY,
    re: /\bimportlib\.import_module\s*\(|\b__import__\s*\(/g,
  },
  {
    // obj.send(:method_name) / public_send / method(:name) — ruby 元编程。
    form: 'ruby-send',
    label: 'send dispatch',
    langs: RB,
    re: /\.(?:public_)?send\s*\(\s*:?\w+|\bmethod\s*\(\s*:\w+\s*\)/g,
    keyFrom: (orig) => {
      const m = orig.match(/:(\w+)/);
      return m ? { key: m[1]! } : undefined;
    },
  },
  {
    // call_user_func([$this, 'method']) / $this->$method() / $callback() —
    // PHP 变量函数和可调用项。
    form: 'php-dynamic',
    label: 'dynamic call',
    langs: PHP,
    re: /\bcall_user_func(?:_array)?\s*\(|\$this\s*->\s*\$\w+\s*\(|\$\w+\s*\(/g,
    keyWindow: 80,
    keyFrom: (orig) => {
      const key = singleStringLiteral(orig);
      return key ? { key } : undefined;
    },
  },
  {
    // 反射：Method.invoke / getMethod("x") / Class.forName / Go
    // reflect MethodByName / C# Activator.CreateInstance, GetMethod。
    form: 'reflection',
    label: 'reflective dispatch',
    langs: JVM_CS_GO,
    re: /\.invoke\s*\(|\.get(?:Declared)?Method\s*\(|\.GetMethod\s*\(|MethodByName\s*\(|Activator\.CreateInstance|Class\.forName\s*\(/g,
    keyWindow: 80,
    keyFrom: (orig) => {
      const key = singleStringLiteral(orig);
      return key ? { key } : undefined;
    },
  },
  {
    // new Proxy(target, handler) / Reflect.get|apply — JS 元对象分发。
    form: 'proxy-reflect',
    label: 'Proxy/Reflect dispatch',
    langs: JS_FAMILY,
    re: /\bnew\s+Proxy\s*\(|\bReflect\.(?:get|apply|construct)\s*\(/g,
  },
  {
    // mediator.Send(new CreateTodoItemCommand(...)) / bus.publish(new OrderEvent(...))
    // — 类型化消息分发（MediatR/CQRS/event-bus）。请求类型是键；
    // 约定的目标是 `<Type>Handler`。
    form: 'typed-bus',
    label: 'typed message dispatch',
    re: /\.(?:[Ss]end|[Pp]ublish|[Dd]ispatch|[Ee]xecute|[Pp]ost|[Ee]mit)(?:Async)?\s*(?:<[^<>\n]{0,80}>)?\s*\(\s*new\s+([A-Z]\w*)/g,
    keyFrom: (orig) => {
      const m = orig.match(/new\s+([A-Z]\w*)$/);
      return m ? { key: m[1]!, keyIsType: true } : undefined;
    },
  },
  {
    // emitter.emit(eventVar, ...) / store.dispatch(action) — 字符串键分发，
    // 但键是*运行时*值。（字面量键的 emit 由合成器处理，当有匹配的处理器时会静态连通。）
    form: 'var-key-dispatch',
    label: 'string-keyed dispatch (runtime key)',
    re: /\.(?:emit|dispatch|trigger|fire|publish|broadcast)\s*\(\s*[A-Za-z_$][\w$]*(?:\.[\w$]+){0,3}\s*[,)]/g,
  },
  {
    // Swift/ObjC：#selector(name) / NSClassFromString — 运行时 selector 分发。
    form: 'selector',
    label: 'selector dispatch',
    langs: SWIFT_OBJC,
    re: /#selector\s*\(\s*([\w.]+)|NSClassFromString\s*\(/g,
    keyFrom: (orig) => {
      const m = orig.match(/#selector\s*\(\s*([\w.]+)/);
      if (!m) return undefined;
      const segs = m[1]!.split('.');
      return { key: segs[segs.length - 1]! };
    },
  },
];

/** 将 Node.language 映射到注释去除器的语言集。 */
function commentLang(language: string): CommentLang | null {
  switch (language) {
    case 'python': return 'python';
    case 'ruby': return 'ruby';
    case 'rust': return 'rust';
    case 'php': return 'php';
    case 'go': return 'go';
    case 'javascript':
    case 'jsx':
      return 'javascript';
    case 'typescript':
    case 'tsx':
    case 'vue':
    case 'svelte':
    case 'astro':
      return 'typescript';
    case 'java':
    case 'kotlin':
    case 'scala':
    case 'dart':
      return 'java';
    case 'csharp': return 'csharp';
    case 'swift': return 'swift';
    case 'c':
    case 'cpp':
    case 'objc':
    case 'objcpp':
      return 'java'; // C 风格注释 + 双引号字符串 — 对于清空来说足够接近
    default: return null;
  }
}

const MAX_MATCHES_PER_BODY = 3;
const MAX_BODY_CHARS = 60_000; // 上帝函数的尾部仍可扫描；超过此限制则截断

/**
 * 清空字符串字面量的*内容*（引号保留，偏移量保留），
 * 以防止文档、错误消息、模板文本中的分发形式误触发匹配器。
 * 在注释去除*之后*运行（注释已替换为空格）。
 * 反斜杠转义已处理；`'`/`"` 字符串在换行时结束（视为未终止，与注释去除器一致）；
 * 反引号跨行，其中的 `${...}` 插值也会被清空 — 遗漏模板字面量内的分发可以接受，
 * 在散文上误触发则不可接受。
 */
export function blankStringContents(text: string): string {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < n) {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (quote !== '`' && text[i] === '\n') break; // unterminated — stop blanking
        if (text[i] !== '\n') out[i] = ' ';           // keep newlines for line math
        i++;
      }
      if (i < n && text[i] === quote) i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * 扫描一个符号的函数体，查找动态分发位置。
 *
 * @param body       符号的源码文本（从文件中切取）
 * @param language   符号的 Node.language
 * @param fileStartLine `body` 在其文件中的 1-based 起始行 —
 *                      返回的行号为绝对文件行号。
 */
export function scanDynamicDispatch(body: string, language: string, fileStartLine: number): BoundaryMatch[] {
  const original = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  const lang = commentLang(language);
  const stripped = blankStringContents(lang ? stripCommentsForRegex(original, lang) : original);

  const out: BoundaryMatch[] = [];
  const seen = new Map<string, BoundaryMatch>(); // form+key → 首个匹配（统计额外次数）

  if (language === 'python') scanPythonGetattr(stripped, original, fileStartLine, out, seen);

  for (const spec of FORMS) {
    if (out.length >= MAX_MATCHES_PER_BODY) break;
    if (spec.langs && !spec.langs.has(language)) continue;
    spec.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = spec.re.exec(stripped)) !== null) {
      let sliceEnd = m.index + m[0].length;
      if (spec.keyWindow) {
        const windowEnd = Math.min(original.length, sliceEnd + spec.keyWindow);
        const nl = original.indexOf('\n', sliceEnd);
        sliceEnd = nl !== -1 && nl < windowEnd ? nl : windowEnd;
      }
      const origSlice = original.slice(m.index, sliceEnd);
      const derived = spec.keyFrom?.(origSlice);
      const dedupeKey = `${spec.form}|${derived?.key ?? ''}`;
      const prior = seen.get(dedupeKey);
      if (prior) {
        prior.moreSites = (prior.moreSites ?? 0) + 1;
        continue;
      }
      const line = fileStartLine + countNewlines(original, m.index);
      const match: BoundaryMatch = {
        form: spec.form,
        label: spec.label,
        snippet: snippetAround(original, m.index),
        line,
        ...(derived ?? {}),
      };
      seen.set(dedupeKey, match);
      out.push(match);
      if (out.length >= MAX_MATCHES_PER_BODY) return out;
    }
  }
  return out;
}

/**
 * Python getattr 分发 — 在代码中处理而非放入 FORMS 表，因为真实的 getattr 调用
 * 的嵌套调用参数可能跨行
 * （`getattr(self, request.method.lower(),\n  self.http_method_not_allowed)` —
 * DRF 的 APIView.dispatch），正则参数类无法限定范围。两种形式：
 *   getattr(obj, name)(args)                      → 立即调用
 *   handler = getattr(obj, name) ... handler(...)  → 赋值后调用
 */
const GETATTR_RE = /\bgetattr\s*\(/g;
const MAX_GETATTR_ARGS = 300;

function scanPythonGetattr(stripped: string, original: string, fileStartLine: number, out: BoundaryMatch[], seen: Map<string, BoundaryMatch>): void {
  GETATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GETATTR_RE.exec(stripped)) !== null && out.length < MAX_MATCHES_PER_BODY) {
    const open = m.index + m[0].length - 1;
    const close = matchBalancedParen(stripped, open);
    if (close === -1) continue;

    let form: string | undefined;
    let label = '';
    // 立即调用：getattr(...)(
    const after = stripped.slice(close + 1, close + 8);
    if (/^\s*\(/.test(after)) {
      form = 'getattr-call';
      label = 'getattr dispatch';
    } else {
      // 赋值形式：向前查找 `name =`，向后查找 `name(`。
      const lineStart = stripped.lastIndexOf('\n', m.index) + 1;
      const before = stripped.slice(lineStart, m.index);
      const assign = before.match(/(\w+)\s*=\s*$/);
      if (assign && new RegExp(`\\b${assign[1]}\\s*\\(`).test(stripped.slice(close + 1))) {
        form = 'getattr-assign';
        label = 'getattr dispatch (assigned, called later)';
      }
    }
    if (!form) continue;

    const key = singleStringLiteral(original.slice(open + 1, close));
    const dedupeKey = `${form}|${key ?? ''}`;
    const prior = seen.get(dedupeKey);
    if (prior) {
      prior.moreSites = (prior.moreSites ?? 0) + 1;
      continue;
    }
    const match: BoundaryMatch = {
      form,
      label,
      snippet: snippetAround(original, m.index),
      line: fileStartLine + countNewlines(original, m.index),
      ...(key ? { key } : {}),
    };
    seen.set(dedupeKey, match);
    out.push(match);
  }
}

/** `text[open]` 对应的 `)` 的索引，若未找到则返回 -1（上限：MAX_GETATTR_ARGS 个字符）。 */
function matchBalancedParen(text: string, open: number): number {
  let depth = 0;
  const end = Math.min(text.length, open + MAX_GETATTR_ARGS);
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

function countNewlines(text: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** 包含 `index` 的完整源码行，已裁剪并截断以供显示。 */
function snippetAround(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  let lineEnd = text.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd).trim();
  return line.length > 120 ? line.slice(0, 117) + '...' : line;
}
