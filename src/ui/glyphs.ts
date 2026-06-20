/**
 * CLI 输出的字形选择。
 *
 * 在 Windows 上，控制台输出通过当前活动输出代码页解释。
 * PowerShell 5.1 和 cmd.exe 默认使用 OEM 代码页（CP437、CP936 等），
 * 因此写入控制台的 UTF-8 字节会渲染为乱码（见 #168）。
 * 微光工作线程受影响最大，因为它使用 `fs.writeSync(1, ...)`（原始字节，
 * 无 TTY 感知的编码转换）以在主线程阻塞于 SQLite 时保持动画流畅。
 * 为在任何环境下都保持可读性，当终端不确定支持 UTF-8 时，
 * 回退到 ASCII 字形。
 *
 * 检测逻辑故意保持简单：
 *   - `SYNAPSE_ASCII=1`   -> ASCII（任何终端的逃生舱）
 *   - `SYNAPSE_UNICODE=1` -> Unicode（Windows 上的手动启用）
 *   - Windows             -> 默认 ASCII
 *   - Linux 内核控制台（`TERM=linux`）-> ASCII
 *   - 其他所有情况        -> Unicode
 */

export function supportsUnicode(): boolean {
  if (process.env.SYNAPSE_ASCII === '1') return false;
  if (process.env.SYNAPSE_UNICODE === '1') return true;
  if (process.platform === 'win32') return false;
  return process.env.TERM !== 'linux';
}

export interface Glyphs {
  ok: string;
  err: string;
  info: string;
  warn: string;
  spinner: string[];
  barFilled: string;
  barEmpty: string;
  rail: string;
  phaseDone: string;
  dash: string;
  hLine: string;
  treeBranch: string;
  treeLast: string;
  treePipe: string;
}

export const UNICODE_GLYPHS: Glyphs = {
  ok: '✓',
  err: '✗',
  info: 'ℹ',
  warn: '⚠',
  spinner: ['·', '✢', '✳', '✶', '✻', '✽'],
  barFilled: '█',
  barEmpty: '░',
  rail: '│',
  phaseDone: '◆',
  dash: '—',
  hLine: '─',
  treeBranch: '├── ',
  treeLast: '└── ',
  treePipe: '│   ',
};

export const ASCII_GLYPHS: Glyphs = {
  ok: '[OK]',
  err: '[ERR]',
  info: '[i]',
  warn: '[!]',
  spinner: ['.', '*', '+', 'x', 'o', 'O'],
  barFilled: '#',
  barEmpty: '-',
  rail: '|',
  phaseDone: '*',
  dash: '-',
  hLine: '-',
  treeBranch: '|-- ',
  treeLast: '`-- ',
  treePipe: '|   ',
};

let cached: Glyphs | null = null;

export function getGlyphs(): Glyphs {
  if (cached === null) {
    cached = supportsUnicode() ? UNICODE_GLYPHS : ASCII_GLYPHS;
  }
  return cached;
}

/** 重置已缓存的字形集。仅供测试使用；生产代码应调用 `getGlyphs()`。 */
export function _resetGlyphsCache(): void {
  cached = null;
}
