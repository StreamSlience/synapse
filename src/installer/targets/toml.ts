/**
 * 轻量 TOML 辅助函数——仅用于在现有 `~/.codex/config.toml` 中注入、
 * 替换或删除单个点分键表格块（`[mcp_servers.synapse]`）。我们刻意不
 * 尝试成为通用的 TOML 解析器/序列化器；那意味着为约 6 行输出引入一个
 * 依赖（~50KB）。
 *
 * 策略：将文件视为纯文本。找到 `[mcp_servers.synapse]` 标题行，将它
 * （以及其后直到下一个 `[...]` 标题或 EOF 的行）插入或删除。块以外的
 * 所有内容均逐字节保留。
 *
 * 局限性（在我们的窄用途下可接受）：
 *   - 仅处理顶层表格标题；不处理数组表格或嵌套在 `[mcp_servers]` 内的
 *     子表格（我们始终写入完整的点分键 `[mcp_servers.synapse]`）。
 *   - 不验证同级 TOML——若文件其他地方格式有误，我们的注入不会修复它，
 *     但也不会让情况更糟。
 *   - 字符串值使用双引号；转义 `\` 和 `"`。
 */

/**
 * 将记录序列化为 TOML 表格的正文行。支持的值类型：string、string[]。
 * 其他类型会抛出异常——Codex MCP 配置只需要这两种类型。
 */
export function serializeTomlTableBody(values: Record<string, string | string[]>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      lines.push(`${key} = ${quoteString(value)}`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      const parts = value.map(quoteString).join(', ');
      lines.push(`${key} = [${parts}]`);
    } else {
      throw new Error(`Unsupported TOML value type for key "${key}"`);
    }
  }
  return lines.join('\n');
}

function quoteString(s: string): string {
  // TOML 基本字符串：反斜杠和双引号需转义；我们的载荷（路径/参数）
  // 中不会出现控制字符。
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * 构建完整的表格块：标题行 + 正文。可直接插入 TOML 文件。
 */
export function buildTomlTable(header: string, values: Record<string, string | string[]>): string {
  return `[${header}]\n${serializeTomlTableBody(values)}`;
}

/**
 * 在给定文件内容中插入或替换顶层点分键 TOML 表格块。逐字保留所有其他内容。
 *
 * 表格为新增时返回 `'inserted'`，现有表格被重写时返回 `'replaced'`，
 * 现有块已与 `block` 逐字节一致时返回 `'unchanged'`。
 */
export function upsertTomlTable(
  fileContent: string,
  header: string,
  block: string,
): { content: string; action: 'inserted' | 'replaced' | 'unchanged' } {
  const headerLine = `[${header}]`;
  const headerIdx = findHeaderIndex(fileContent, headerLine);

  if (headerIdx === -1) {
    // 在末尾插入，若已有内容则以空行分隔。
    const trimmed = fileContent.trimEnd();
    const sep = trimmed.length > 0 ? '\n\n' : '';
    return {
      content: trimmed + sep + block + '\n',
      action: 'inserted',
    };
  }

  // Find the end of this block: next `[...]` header (at line start) or EOF.
  const blockEnd = findNextTableHeader(fileContent, headerIdx + headerLine.length);
  const existingBlock = fileContent.substring(headerIdx, blockEnd).replace(/\n+$/, '');

  if (existingBlock === block) {
    return { content: fileContent, action: 'unchanged' };
  }

  const before = fileContent.substring(0, headerIdx);
  const after = fileContent.substring(blockEnd);
  // 从 `before` 末尾裁去多余空行（稍后重新添加一行），并从 `after`
  // 开头裁去空行，使文件整体格式保持整洁。
  const beforeClean = before.replace(/\n+$/, '');
  const afterClean = after.replace(/^\n+/, '');
  const sepBefore = beforeClean.length > 0 ? '\n\n' : '';
  const sepAfter = afterClean.length > 0 ? '\n\n' : '\n';
  return {
    content: beforeClean + sepBefore + block + sepAfter + afterClean,
    action: 'replaced',
  };
}

/**
 * 删除顶层点分键 TOML 表格块。返回可能为空的新内容及操作标志。
 */
export function removeTomlTable(
  fileContent: string,
  header: string,
): { content: string; action: 'removed' | 'not-found' } {
  const headerLine = `[${header}]`;
  const headerIdx = findHeaderIndex(fileContent, headerLine);
  if (headerIdx === -1) return { content: fileContent, action: 'not-found' };

  const blockEnd = findNextTableHeader(fileContent, headerIdx + headerLine.length);
  const before = fileContent.substring(0, headerIdx).replace(/\n+$/, '');
  const after = fileContent.substring(blockEnd).replace(/^\n+/, '');
  const joined = before + (before && after ? '\n\n' : '') + after;
  return { content: joined, action: 'removed' };
}

/**
 * 定位标题行（`[foo.bar]`）在行首出现时的字节索引。未找到时返回 -1。
 */
function findHeaderIndex(content: string, headerLine: string): number {
  // 搜索行首或换行符之后。
  if (content.startsWith(headerLine)) return 0;
  const needle = '\n' + headerLine;
  const idx = content.indexOf(needle);
  return idx === -1 ? -1 : idx + 1;
}

/**
 * 从 `from` 位置开始，查找下一个顶层 `[...]` 表格标题
 * （排除数组表格 `[[...]]`）的字节索引，若无则返回内容长度。
 */
function findNextTableHeader(content: string, from: number): number {
  // 查找 "\n["，但跳过 "\n[["（数组表格）。
  let i = from;
  while (i < content.length) {
    const nlIdx = content.indexOf('\n[', i);
    if (nlIdx === -1) return content.length;
    if (content[nlIdx + 2] === '[') {
      // [[...]]——继续向后搜索。
      i = nlIdx + 2;
      continue;
    }
    return nlIdx + 1;
  }
  return content.length;
}
