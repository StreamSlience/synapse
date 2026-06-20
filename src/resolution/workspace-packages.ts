/**
 * JavaScript/TypeScript 工作区（monorepo）包解析。
 *
 * npm / yarn / bun 从根目录 `package.json` 的 `workspaces` 字段读取成员包；
 * pnpm 从 `pnpm-workspace.yaml` 读取。跨包导入（如 `@scope/ui/widgets`）
 * 在 monorepo 中是本地的，但对单包解析器来说，它看起来与第三方 npm
 * 说明符完全相同——导致 `isExternalImport` 将其标记为外部，
 * 消费者与定义之间的边永远无法建立。对于组件桶文件
 * （`export { default as X } from './x.svelte'`），
 * 这会造成某个存活组件被误报为 `0 callers`（issue #629）。
 *
 * 本模块将每个成员包声明的 `name` 映射到其目录，
 * 使解析器能够将 `@scope/ui/widgets` 改写为
 * `packages/ui/widgets`，再进行正常的扩展名/index 解析。
 *
 * v1 范围刻意保持精简（与 path-aliases.ts 保持一致）：
 *   - 从 package.json 读取 `workspaces`（数组或 `{ packages: [...] }` 对象形式），
 *     以及最小化的 `pnpm-workspace.yaml` `packages:` 列表
 *   - 展开一层 `*` / `**` glob（`packages/*`、`apps/*`）
 *   - 子路径解析基于目录（`@scope/ui/sub` → `<ui>/sub`）；
 *     尚不支持成员的 `exports` 映射或 `main` 字段
 *   - 当项目未声明工作区时返回 null，单包仓库不受任何影响，行为不变。
 */

import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';

export interface WorkspacePackages {
  /** 成员包 `name` → 相对于 projectRoot 的目录路径（posix 格式）。 */
  byName: Map<string, string>;
}

/**
 * 加载 `projectRoot` 的工作区成员包。当项目未声明工作区时返回 `null`
 * （即常见的单包情形）——调用方可据此跳过所有工作区逻辑。
 *
 * 仅通过解析器的实例级缓存重复调用时才廉价；
 * 本函数自身会访问文件系统，因此解析器以与
 * {@link loadProjectAliases} / {@link loadGoModule} 相同的方式对其进行记忆化。
 */
export function loadWorkspacePackages(projectRoot: string): WorkspacePackages | null {
  const patterns = readWorkspaceGlobs(projectRoot);
  if (patterns.length === 0) return null;

  const byName = new Map<string, string>();
  for (const pattern of patterns) {
    for (const dir of expandWorkspaceGlob(projectRoot, pattern)) {
      const pkgName = readPackageName(path.join(projectRoot, dir));
      // 首次声明优先——工作区模式按顺序尝试。
      if (pkgName && !byName.has(pkgName)) byName.set(pkgName, dir);
    }
  }
  if (byName.size === 0) return null;

  logDebug('workspace packages loaded', { count: byName.size });
  return { byName };
}

/**
 * 将裸工作区导入改写为相对于 projectRoot 的路径（不含扩展名）——
 * 由调用方应用对应语言的扩展名/index 解析。
 * `@scope/ui/widgets` → `packages/ui/widgets`；
 * 裸包名 `@scope/ui` → 其目录。
 * 当没有成员包名称匹配时返回 `null`。
 */
export function resolveWorkspaceImport(
  importPath: string,
  ws: WorkspacePackages
): string | null {
  // 最长匹配的包名优先，因此 `@scope/ui/core` 在两者都存在时
  // 优先匹配 `@scope/ui/core` 包而非 `@scope/ui` 包。
  let bestName: string | null = null;
  for (const name of ws.byName.keys()) {
    if (importPath === name || importPath.startsWith(name + '/')) {
      if (!bestName || name.length > bestName.length) bestName = name;
    }
  }
  if (!bestName) return null;
  const dir = ws.byName.get(bestName)!;
  const subpath = importPath.slice(bestName.length); // '' or '/widgets'
  return (dir + subpath).replace(/\/{2,}/g, '/');
}

/** 从 package.json 和 pnpm-workspace.yaml 读取工作区 glob 模式。 */
function readWorkspaceGlobs(projectRoot: string): string[] {
  const out: string[] = [];

  // package.json `workspaces`（npm / yarn / bun）：数组形式，
  // 或 Yarn 的 `{ packages: [...], nohoist: [...] }` 对象形式。
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
    );
    const ws = pkg?.workspaces;
    if (Array.isArray(ws)) {
      out.push(...ws.filter((w: unknown): w is string => typeof w === 'string'));
    } else if (ws && Array.isArray(ws.packages)) {
      out.push(...ws.packages.filter((w: unknown): w is string => typeof w === 'string'));
    }
  } catch {
    /* 没有 / 无效的 package.json——不是工作区根目录 */
  }

  // pnpm-workspace.yaml `packages:` 列表。使用最小化的行扫描器解析，
  // 避免引入 YAML 依赖。
  try {
    const yaml = fs.readFileSync(path.join(projectRoot, 'pnpm-workspace.yaml'), 'utf-8');
    out.push(...parsePnpmPackages(yaml));
  } catch {
    /* 没有 pnpm-workspace.yaml */
  }

  return out;
}

/**
 * 最小化的 pnpm-workspace.yaml `packages:` 提取器。仅处理 pnpm 实际使用的格式：
 *   packages:
 *     - 'packages/*'
 *     - "apps/*"
 *     - tools/build
 */
function parsePnpmPackages(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split(/\r?\n/);
  let inPackages = false;
  for (const line of lines) {
    if (/^\s*packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) {
        out.push(item[1]!.replace(/^['"]|['"]$/g, ''));
        continue;
      }
      // 非列表、非空行表示 `packages:` 块结束。
      if (line.trim() !== '' && !/^\s/.test(line)) inPackages = false;
    }
  }
  return out;
}

/** 将一个 `packages/*` / `apps/**` glob 展开为成员目录列表。 */
function expandWorkspaceGlob(projectRoot: string, pattern: string): string[] {
  const norm = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  const star = norm.indexOf('*');
  if (star === -1) return [norm]; // 精确目录，无需展开

  // 通配符之前的所有内容即为待枚举的基础路径。
  const base = norm.slice(0, star).replace(/\/+$/, '');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(projectRoot, base), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    out.push(base ? `${base}/${e.name}` : e.name);
  }
  return out;
}

/** 从成员目录的 package.json 中读取 `name` 字段。 */
function readPackageName(dirAbs: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dirAbs, 'package.json'), 'utf-8'));
    return typeof pkg?.name === 'string' && pkg.name ? pkg.name : null;
  } catch {
    return null;
  }
}
