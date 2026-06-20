/**
 * 已解析的包版本，在模块加载时计算一次。
 *
 * 版本字符串是协作守护进程与代理进程之间的会合数据：守护进程在 hello 行中
 * 广播其版本，代理在版本不匹配时拒绝共享 IPC（回退到直接模式）。
 * 将解析集中在一处，避免 CLI `--version` 输出（直接读取 `package.json`）
 * 与守护进程握手之间产生偏差。
 *
 * 解析策略：从此文件向上两级读取打包的 `package.json` —
 * 无论从 `src/mcp/` 还是 `dist/mcp/` 输出加载，相对位置相同，
 * 因为 `tsc` 保留了目录结构。如果读取失败
 * （例如包被奇怪地解压），回退到 "0.0.0-unknown" —
 * 这是一个永远不会匹配真实版本的哨兵，代理会无害地回退到直接模式。
 */

import * as fs from 'fs';
import * as path from 'path';

function readPackageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to sentinel.
  }
  return '0.0.0-unknown';
}

export const SynapsePackageVersion = readPackageVersion();
