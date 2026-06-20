/**
 * Go 模块路径检测。
 *
 * Go monorepo 的跨包调用（`pkga.FuncX(...)`）只有在解析器知道项目的模块路径
 * （`go.mod` 中的 `module ...` 指令）时才能正确解析。若没有该信息，
 * `isExternalImport` 会将每一个模块内的导入——如
 * `github.com/example/myproject/pkga`——都视为第三方包，
 * 导致解析回退到名称匹配加路径邻近度，最终只能返回真实调用点中极小的一部分。
 * 参见 issue #388。
 */

import * as fs from 'fs';
import * as path from 'path';

export interface GoModule {
  /** `go.mod` 中声明的模块路径，例如 `github.com/example/myproject` */
  modulePath: string;
  /** 包含 `go.mod` 文件的目录的绝对路径。 */
  rootDir: string;
}

/**
 * 读取项目根目录下的 `go.mod` 文件并提取模块路径。
 * 若不存在 `go.mod` 或其中没有 `module` 指令，则返回 `null`。
 *
 * 限制：仅读取项目根目录下的 `go.mod`。嵌套的 `go.mod` 文件
 * （Go workspaces、包含多个模块的 monorepo）目前不支持——
 * 若有真实复现案例，可在后续跟进处理。
 */
export function loadGoModule(projectRoot: string): GoModule | null {
  const goModPath = path.join(projectRoot, 'go.mod');
  let content: string;
  try {
    content = fs.readFileSync(goModPath, 'utf-8');
  } catch {
    return null;
  }
  // `module <path>` 是任何合法 go.mod 中第一个非注释指令。
  // 先去掉行注释，避免 `// module foo` 造成误匹配。
  const stripped = content.replace(/\/\/[^\n]*/g, '');
  const match = stripped.match(/^\s*module\s+(\S+)\s*$/m);
  if (!match) return null;
  // 去掉模块路径周围的可选引号。
  const modulePath = match[1]!.replace(/^["']|["']$/g, '');
  if (!modulePath) return null;
  return { modulePath, rootDir: projectRoot };
}
