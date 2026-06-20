/**
 * 将 stdin 失败视为关闭信号 — issue #799。
 *
 * MCP stdio 服务器的生命线是其 stdin：当宿主/客户端消失时，
 * stdin 应该结束，服务器应该退出。服务器路径监听了 `'end'` 和 `'close'` —
 * 但没有监听 `'error'`。
 *
 * 这个漏洞在 socket 后端的 stdin 上会产生问题，这正是 VS Code /
 * Claude Code 的形式（socketpair，不是 pipe）。当客户端死亡时，socket
 * 可能以 `'error'`（ECONNRESET / hangup）而非干净的 `'close'` 结束。
 * 没有 `'error'` 监听器时，Node 将其升级为进程级 `uncaughtException` 处理器，
 * 后者记录日志后继续运行 — 服务器因此变成孤儿而不是退出。更糟的是，
 * 在 Linux 上，注册在 epoll 中的 `POLLHUP` socket fd 会持续唤醒事件循环，
 * 将一个 CPU 核心固定在 100%（#799 中报告的自旋）；一旦主线程自旋，
 * `setInterval` PPID 看门狗甚至无法触发，孤儿进程就会永远运行。
 *
 * 修复：同样监听 `'error'`，并在任何终止事件时*销毁* stdin 流，
 * 使 fd 离开 epoll 不再持续扰动，然后执行调用方的关闭逻辑。
 * `onTerminal` 最多触发一次 — 调用方的关闭已有重入保护，
 * 但一次性门控也防止 `destroy()` 的后续 `'close'` 重复调用它。
 *
 * `stream` 可注入以供测试；默认为 `process.stdin`。
 */
export function treatStdinFailureAsShutdown(
  onTerminal: () => void,
  stream: NodeJS.ReadableStream = process.stdin
): void {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    // 将 fd 从 epoll 中移除，防止挂起/半关闭的 socket 持续唤醒事件循环。
    // 尽力而为：流可能已经被拆除。
    try {
      (stream as Partial<{ destroy(): void }>).destroy?.();
    } catch {
      /* already gone */
    }
    onTerminal();
  };
  stream.on('end', fire);
  stream.on('close', fire);
  stream.on('error', fire);
}
