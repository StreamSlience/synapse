/**
 * 安装器的智能体 target 抽象。
 *
 * 每个支持 MCP 的智能体（Claude Code、Cursor、Codex CLI、opencode……）
 * 都实现此接口，安装器编排器由此可以为该智能体写入正确的 MCP 服务器配置、
 * instructions 文件和权限，而无需将客户端专属路径硬编码到核心代码中。
 * 新增智能体 = 在 `targets/` 中新建一个文件 + 在 `registry.ts` 中添加一条记录。
 *
 * 关闭了仅限 Claude 的安装器问题（上游 #137）。运行时 MCP 服务器本已与智能体
 * 无关；此举将安装器带到同一水平。
 */

export type Location = 'global' | 'local';

/**
 * 在 `--target` CLI 标志和注册表查找中使用的稳定字符串 id。
 * 新 target 加入注册表时在此处添加一个值。保持简短且小写。
 */
export type TargetId = 'claude' | 'cursor' | 'codex' | 'opencode' | 'hermes' | 'gemini' | 'antigravity' | 'kiro';

/**
 * `target.detect(location)` 的返回结果。
 *
 * `installed` 是尽力而为的启发式判断，表示该智能体的 CLI / 应用 /
 * 配置目录是否存在于当前系统——用于将多选提示默认勾选"实际存在"的内容。
 * 误报可以接受（我们仍会写入）；漏报仅意味着用户需要手动选择。
 *
 * `alreadyConfigured` 报告 synapse 是否已在此位置连接到该 target——
 * 驱动"Updated"与"Added"日志行，并让 `--check` 以 0/1 退出。
 */
export interface DetectionResult {
  installed: boolean;
  alreadyConfigured: boolean;
  /** 已检查的路径；显示在诊断/试运行输出中。 */
  configPath?: string;
}

/**
 * `target.install(location)` 实际在磁盘上完成的变更。编排器使用 `action`
 * 为每个文件渲染一行日志。
 *
 * `unchanged` 表示我们访问了该文件，但其内容已与我们要写入的内容完全一致——
 * 用于字节完全相同的幂等重复运行。
 */
export interface WriteResult {
  files: Array<{
    path: string;
    action: 'created' | 'updated' | 'unchanged' | 'removed' | 'not-found' | 'kept';
  }>;
  /**
   * 编排器逐字展示的可选单行说明——例如
   * "重启 Cursor 以应用更改。"保持简短；多行内容放入 README。
   */
  notes?: string[];
}

export interface InstallOptions {
  /**
   * 是否写入智能体的权限/自动允许配置
   * （Claude `settings.json`，其他目标在适用时同样处理）。
   * 若目标没有权限概念，此选项为空操作。
   */
  autoAllow: boolean;
}

export interface AgentTarget {
  /** 稳定 id；与 `TargetId` 联合类型匹配。 */
  readonly id: TargetId;
  /** 在 clack 提示和日志行中显示的可读名称。 */
  readonly displayName: string;
  /** 可选 URL，用于"在哪里了解更多关于此智能体的信息"。 */
  readonly docsUrl?: string;
  /**
   * 此 target 是否支持给定的安装位置。
   *
   * 部分智能体（截至 2026-05 的 Codex CLI）没有项目本地配置概念——
   * 只有单一的 `~/.codex/` 目录。对不支持的（target, location）组合
   * 返回 false，可让编排器以清晰的消息跳过。
   */
  supportsLocation(loc: Location): boolean;
  detect(loc: Location): DetectionResult;
  install(loc: Location, opts: InstallOptions): WriteResult;
  /**
   * install 的逆操作。仅删除 install 写入的内容；
   * 保留同级 MCP 服务器、同级权限以及无关的 markdown 章节。
   * 在从未安装过的情况下调用必须是安全的（返回 `not-found` action）。
   */
  uninstall(loc: Location): WriteResult;
  /**
   * 打印用户可手动粘贴的此 target 的 MCP 服务器片段。
   * 供 `synapse install --print-config <id>` 及 README 使用。
   * 绝不得访问文件系统。
   */
  printConfig(loc: Location): string;
  /** 此 target 在该位置会写入的文件系统路径。 */
  describePaths(loc: Location): string[];
}
