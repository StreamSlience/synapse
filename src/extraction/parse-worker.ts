/**
 * 解析 Worker
 *
 * 在独立线程中运行 tree-sitter 解析，使主线程保持不阻塞，
 * UI 动画可以流畅渲染。
 */

import { parentPort } from 'worker_threads';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, loadGrammarsForLanguages, resetParser } from './grammars';
import type { Language, ExtractionResult } from '../types';

// Emscripten 在 WASM 中止时会直接向 stderr 打印 `Aborted()`（以及后续
// 的 RuntimeError 诊断行）——早于 JS catch 执行。Worker 的 stderr 由父
// 进程继承，因此每次崩溃都会向用户终端泄露一行噪声，尽管 JS 层已经
// 干净地处理了该失败。在源头过滤掉这些特定行。真正的诊断输出（我们
// 自己记录的任何内容）通过 console.* / parentPort 传递，不受影响。
//
// 已刻意接受的注意事项：
//   - 逐次调用匹配：每次 `write()` 调用独立匹配。
//     若 Emscripten 将 `Aborted(` 拆分到两次 write() 调用中（目前不会
//     ——同步中止通过 libc puts 一次性打印整行），第一个片段会泄露。
//     跨调用缓冲会为假设情况增加复杂性。
//   - 子串精确性：前缀 `Aborted(` 是 Emscripten 的字面签名。任何用户
//     代码若合法地向 stderr 写入以该前缀开头的行也会被过滤；实践中
//     没有真正的诊断信息会这样做。
{
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (
      s.startsWith('Aborted(') ||
      s.includes('Build with -sASSERTIONS for more info')
    ) {
      // 遵守 Writable 流契约：即使写入被抑制，回调也必须始终触发，
      // 否则等待 drain 信号的上游代码会挂起。两种重载形式都已处理
      // （`(chunk, cb)` 和 `(chunk, encoding, cb)`）。
      if (typeof encoding === 'function') encoding();
      else if (cb) cb();
      return true;
    }
    return realWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write;
}

const PARSER_RESET_INTERVAL = 5000;
const parseCounts = new Map<Language, number>();

parentPort!.on('message', async (msg: { type: string; id?: number; filePath?: string; content?: string; languages?: Language[]; frameworkNames?: string[] }) => {
  if (msg.type === 'load-grammars') {
    await loadGrammarsForLanguages(msg.languages!);
    parentPort!.postMessage({ type: 'grammars-loaded' });
  } else if (msg.type === 'parse') {
    const { id, filePath, content, frameworkNames } = msg;
    try {
      const language = detectLanguage(filePath!, content);
      const result: ExtractionResult = extractFromSource(filePath!, content!, language, frameworkNames);

      // 定期重置 parser 以回收 WASM 堆内存
      const count = (parseCounts.get(language) ?? 0) + 1;
      parseCounts.set(language, count);
      if (count % PARSER_RESET_INTERVAL === 0) {
        resetParser(language);
      }

      parentPort!.postMessage({ type: 'parse-result', id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // WASM 内存错误会使模块进入损坏状态——后续所有解析也会失败
      // （级联故障）。崩溃 worker，使主线程生成一个拥有干净堆的新 worker。
      if (message.includes('memory access out of bounds') || message.includes('out of memory')) {
        process.exit(1);
      }

      parentPort!.postMessage({
        type: 'parse-result',
        id,
        result: {
          nodes: [],
          edges: [],
          unresolvedReferences: [],
          errors: [{ message: `Parse worker error: ${message}`, filePath: filePath!, severity: 'error', code: 'parse_error' }],
          durationMs: 0,
        } satisfies ExtractionResult,
      });
    }
  } else if (msg.type === 'shutdown') {
    parentPort!.postMessage({ type: 'shutdown-ack' });
  }
});
