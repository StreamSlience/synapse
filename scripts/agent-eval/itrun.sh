#!/usr/bin/env bash
# 在 tmux 中驱动一次交互式 Claude Code 会话：发送提示词，等待 agent 完成，
# 然后从会话日志中打印工具调用摘要。
#
# 为何使用交互式（而非 `claude -p`）：无头打印模式会选用通用子智能体，
# 而真实交互式会话会委托给 Explore 子智能体（或从主线程驱动 synapse）。
# 只有交互式 TUI 才能复现用户实际看到的行为。（空闲检测技术借鉴自
# devpit 的 WaitForIdle。）
#
# 用法：itrun.sh <repo-path> <label> "<prompt>"
# 输出目录：$AGENT_EVAL_OUT（默认 /tmp/agent-eval）
# 依赖：tmux 3.0+，已登录的 `claude` CLI，已配置 synapse MCP。
set -uo pipefail
REPO="$1"; LABEL="$2"; PROMPT="$3"
SESSION="cgt_${LABEL}"
OUT_DIR="${AGENT_EVAL_OUT:-/tmp/agent-eval}"; mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/itrun-${LABEL}.txt"
HERE="$(cd "$(dirname "$0")" && pwd)"

cap() { tmux capture-pane -p -t "$SESSION" -S -40; }

tmux kill-session -t "$SESSION" 2>/dev/null

# 宽面板，防止 TUI 对工具行硬换行。
tmux new-session -d -s "$SESSION" -x 230 -y 60
tmux send-keys -t "$SESSION" "cd $REPO && claude --dangerously-skip-permissions ${CLAUDE_EXTRA_ARGS:-}" Enter

# 等待 ❯ 提示符出现（claude 已绘制 UI），最多 60s。注意：❯ 出现在欢迎屏幕上，
# 比输入框实际接受按键早数秒，因此这是必要条件但非充分条件——
# 下面的「输入并验证」循环才是证明输入已就绪的依据。
ready=0
for _ in $(seq 1 120); do
  cap | grep -q "❯" && { ready=1; break; }
  sleep 0.5
done
[ "$ready" = 1 ] || { echo "claude never drew its UI"; cap; tmux kill-session -t "$SESSION" 2>/dev/null; exit 1; }

# 如果出现「Is this a project you trust?」对话框则接受（首次打开某代码库时）。
# 选项 1（"Yes, I trust this folder"）默认选中，直接按 Enter 即可。
# 该对话框也含有 ❯，因此必须在「输入并验证」循环前清除，
# 否则按键会落在菜单上。
for _ in $(seq 1 20); do
  cap | grep -q "trust this folder" || break
  tmux send-keys -t "$SESSION" Enter
  sleep 1
done

# 输入并验证：发送提示词，确认其有代表性的片段确实出现在输入框中，
# 否则重试（处理「早出现的 ❯」竞态——欢迎屏幕已显示提示符字形
# 但 MCP init 仍在消耗按键）。
needle="${PROMPT:0:24}"
typed=0
for _ in $(seq 1 30); do
  tmux send-keys -l -t "$SESSION" "$PROMPT"
  sleep 1
  if cap | grep -Fq "$needle"; then typed=1; break; fi
  # 清除已落下的任何部分文本，然后重试。
  tmux send-keys -t "$SESSION" C-u
  sleep 1
done
[ "$typed" = 1 ] || { echo "prompt never landed in the input box"; cap; tmux kill-session -t "$SESSION" 2>/dev/null; exit 1; }
sleep 0.5
tmux send-keys -t "$SESSION" Enter

# 「忙碌」信号。最可靠的是 spinner 括号内的耗时显示，所有工作状态均会展示——
# 包括流式前的思考阶段「(8s · thinking with max effort)」以及
# 流式阶段「(24s · ↑ 2.5k tokens · …)」，且能正确处理 32s→"1m 3s" 的滚动。
# 还追加了 token 箭头、"esc to interrupt"、"Initializing" 作为双重保险
#（某些 TUI 版本/状态只显示其中一种）。
BUSY_RE='esc to interrupt|↓ [0-9]|↑ [0-9]|Initializing|\(([0-9]+m )?[0-9]+s ·'

# 等待工作开始（忙碌指示器出现），最多 60s。若从未开始，
# 大声报错而非静默报告空运行。
started=0
for _ in $(seq 1 120); do
  cap | grep -qE "$BUSY_RE" && { started=1; break; }
  sleep 0.5
done
[ "$started" = 1 ] || { echo "agent never started working"; cap; tmux kill-session -t "$SESSION" 2>/dev/null; exit 1; }

# 轮询空闲。关键：Opus 4.8（扩展思考）在流式输出最终答案时不渲染任何 spinner /
# "esc to interrupt" / 计时器——这些只在思考+工具调用阶段出现
#（"✻ Marinating… (32s · ↓ 1.3k tokens · thinking with max effort)"）。
# 因此 BUSY_RE 在整个 10-30s 的答案流式期间读作"不忙碌"，任何短暂的
# "不忙碌"阈值都会在答案中途杀掉运行（截断 bug）。
# 因此我们通过内容稳定性而非 spinner 字符串来检测"完成"：
# 在 agent 流式期间，捕获面板每次轮询都会变化，稳定性不会累积；
# 只有 agent 完成、静态的"✻ Brewed for 1m 9s"摘要留存时，稳定性才会累积。
# BUSY_RE 仍会强制重置稳定性（覆盖思考/工具调用/实时计时，那时文字可能短暂静止）。
# 需要连续 STABLE_NEEDED 次（约 8s）面板无变化 + 有 ❯ 出现。
# 内容稳定性与模型无关——兼容未来 spinner 措辞的变化。
STABLE_NEEDED=16
prev=""; stable=0
for _ in $(seq 1 2400); do            # up to ~20 min
  pane="$(cap)"
  sig="$(printf '%s' "$pane" | tr -s '[:space:]' ' ')"
  if printf '%s' "$pane" | grep -qE "$BUSY_RE"; then
    stable=0                          # 思考 / 工具调用 / 实时计时 → 忙碌
  elif [ -n "$sig" ] && [ "$sig" = "$prev" ] && printf '%s' "$pane" | grep -q "❯"; then
    stable=$((stable+1)); [ "$stable" -ge "$STABLE_NEEDED" ] && break
  else
    stable=0                          # 答案仍在流式输出 → 面板持续变化
  fi
  prev="$sig"
  sleep 0.5
done
sleep 1

tmux capture-pane -p -t "$SESSION" -S - > "$OUT"
echo "captured $(wc -l < "$OUT") lines -> $OUT"
grep -oE "Done \([^)]*\)|[A-Z][a-z]+ for ([0-9]+m )?[0-9]+s" "$OUT" | tail -1
grep -oE "[0-9.]+k?/[0-9.]+M" "$OUT" | tail -1 | sed 's/^/Context /'
tmux kill-session -t "$SESSION" 2>/dev/null

# 从会话日志（主进程 + 子智能体）中提取工具调用摘要。
node "$HERE/parse-session.mjs" "$REPO" 2>/dev/null || true
