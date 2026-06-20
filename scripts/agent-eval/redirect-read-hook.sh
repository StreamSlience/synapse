#!/usr/bin/env bash
# PreToolUse(Read) 重定向 hook——A/B 原型（P1：不仅用于 Q&A，也在实现阶段
# 让 agent 脱离 Read、转向 synapse_node）。
#
# 当 agent Read 某个源文件时，拒绝并引导至 synapse_node 的文件视图：
# 该视图（自 Lever-1 变更起）会带行号地逐字返回整个文件——
# imports、顶层代码、注释等全部包含——再加上文件的影响半径，一次调用全搞定。
# 该输出是 Read 的严格超集，因此重定向是无损的：agent 不会损失任何内容，
# 还能额外获取「谁依赖此文件」的信息，为即将进行的编辑做好准备。
#
# 与 block-read-hook.sh（引导至 explore/按符号查 node）的区别：
# 本 hook 明确指定文件视图路径（file:"<base>" + includeCode:true），
# 即我们希望在实现阶段被采用的 1:1 Read 替代方案。
#
# 非源文件（配置、文档、锁文件、.env）直接放行，走真实的 Read。
# 重定向到 synapse 未索引的文件时会自我修正：文件视图会回复
# "No indexed file matches … Read it directly"，因此刚创建的文件
# 永远不会死路——agent 会在下一轮直接 Read 它。
#
# 接入方式：claude ... --settings <将本文件设为 PreToolUse(Read) 的 settings>
# 仅限评估使用。生产版本是感知索引的 `synapse` 子命令（跨平台——无 bash/jq 依赖——
# 查询索引以确保新文件/未索引文件不会被拒绝），通过安装器按需接入。
set -uo pipefail
input="$(cat)"
fp="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$fp" ] || exit 0
base="$(basename "$fp")"

case "$fp" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.java|*.rb|*.php|*.swift|*.kt|*.kts|*.scala|*.c|*.cc|*.cpp|*.h|*.hpp|*.cs|*.lua|*.vue|*.svelte|*.m|*.mm)
    msg="synapse has this file indexed (kept in sync on every edit). Call synapse_node with file:\"$base\" and includeCode:true instead of Read — it returns the WHOLE file verbatim WITH line numbers (imports, top-level code and all — safe to base an Edit on) PLUS which files depend on it, in one call. Treat its output as already-Read; do not Read this file. (If it answers that the file isn't indexed — e.g. you just created it — then Read it directly.)"
    jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$m}}'
    exit 0
    ;;
esac
exit 0
