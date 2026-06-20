/**
 * 字段限定搜索查询解析器。
 *
 * 将如下原始查询
 *
 *     kind:function name:auth path:src/api authenticate
 *
 * 拆分为结构化过滤器（kind=function、name="auth"、path 前缀
 * "src/api"）以及送入 FTS 的自由文本部分（"authenticate"）。
 * 自由文本与过滤器可组合使用：过滤器缩小结果集，FTS 在缩小后的
 * 结果集内打分。
 *
 * 支持的字段（大小写不敏感，值为下一个空白字符之前的内容）：
 *
 *   kind:    function|method|class|interface|struct|... 之一
 *   lang:    typescript|python|go|... 之一   （别名：language:）
 *   path:    file_path 的大小写不敏感子串
 *   name:    符号名称的大小写不敏感子串
 *
 * 未知字段前缀（如 `foo:bar`）会作为纯文本传给 FTS——
 * 这样搜索 `TODO:` 时会返回结果而不是解析错误。
 *
 * 引号处理：
 *   kind:function path:"src/some path/with spaces" → 通过去除值两侧的
 *   双引号来处理（仅限单一 token，不支持嵌套转义）。
 */

import { NODE_KINDS, LANGUAGES } from '../types';
import type { NodeKind, Language } from '../types';

export interface ParsedQuery {
  /** 送入 FTS / LIKE 的自由文本部分，可为空。 */
  text: string;
  /** kind: 过滤器（取 OR）。未指定时为空。 */
  kinds: NodeKind[];
  /** lang:/language: 过滤器（取 OR）。未指定时为空。 */
  languages: Language[];
  /** path: 过滤器（取 OR，对 file_path 大小写不敏感子串匹配）。未指定时为空。 */
  pathFilters: string[];
  /** name: 过滤器（取 OR，对 node.name 大小写不敏感子串匹配）。 */
  nameFilters: string[];
}

// 派生自 types.ts 中权威的 `NODE_KINDS` / `LANGUAGES` 数组，
// 这样新增 kind 或 language 时不会悄悄地走到纯文本分支。
const KIND_VALUES: ReadonlySet<string> = new Set<NodeKind>(NODE_KINDS);
const LANGUAGE_VALUES: ReadonlySet<string> = new Set<Language>(LANGUAGES);

/**
 * 去除 `s` 两侧的双引号。允许用户在路径过滤器中保留空格：
 * `path:"my dir/file"`。
 */
function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/**
 * 将原始查询解析为结构化过滤器 + 剩余文本。
 * 始终返回值，从不抛出异常。
 */
export function parseQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = {
    text: '',
    kinds: [],
    languages: [],
    pathFilters: [],
    nameFilters: [],
  };

  // 按空白字符分词，同时将引号内的内容保留为当前 token 的一部分。
  // 引号可出现在开头（`"…"`）或 token 中间（`path:"…"`）；
  // 两种情况下，从开头 `"` 到匹配的 `"` 之间的所有内容（含空格）
  // 都包含在该 token 中。
  const tokens: string[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
    if (i >= raw.length) break;
    const start = i;
    while (i < raw.length && !/\s/.test(raw[i]!)) {
      if (raw[i] === '"') {
        const end = raw.indexOf('"', i + 1);
        if (end === -1) {
          // 未闭合的引号——将剩余输入全部作为一个 token 吞入。
          // 宽容处理，不抛出异常。
          i = raw.length;
          break;
        }
        i = end + 1;
        continue;
      }
      i++;
    }
    tokens.push(raw.slice(start, i));
  }

  const textParts: string[] = [];
  for (const tok of tokens) {
    const colon = tok.indexOf(':');
    if (colon <= 0 || colon === tok.length - 1) {
      textParts.push(tok);
      continue;
    }
    const key = tok.slice(0, colon).toLowerCase();
    const valueRaw = unquote(tok.slice(colon + 1));
    if (!valueRaw) {
      textParts.push(tok);
      continue;
    }
    switch (key) {
      case 'kind': {
        if (KIND_VALUES.has(valueRaw)) {
          out.kinds.push(valueRaw as NodeKind);
        } else {
          textParts.push(tok);
        }
        break;
      }
      case 'lang':
      case 'language': {
        const lower = valueRaw.toLowerCase();
        if (LANGUAGE_VALUES.has(lower)) {
          out.languages.push(lower as Language);
        } else {
          textParts.push(tok);
        }
        break;
      }
      case 'path':
        out.pathFilters.push(valueRaw);
        break;
      case 'name':
        out.nameFilters.push(valueRaw);
        break;
      default:
        textParts.push(tok);
    }
  }

  out.text = textParts.join(' ').trim();
  return out;
}

/**
 * 有界 Damerau-Levenshtein 编辑距离。一旦确认距离超过 `maxDist`
 * 就立即返回 `maxDist + 1`；这种提前退出机制使模糊回退即便面对
 * 数万个名称也开销极低。
 *
 * 纯 DP，O(min(len(a), len(b))) 空间复杂度。比较折叠大小写后的输入；
 * 调用方应传入 `lowercase(name)` 字符串。
 */
export function boundedEditDistance(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = new Array<number>(bl + 1);
  let cur = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const insertion = cur[j - 1]! + 1;
      const deletion = prev[j]! + 1;
      const substitution = prev[j - 1]! + cost;
      cur[j] = Math.min(insertion, deletion, substitution);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[bl]!;
}
