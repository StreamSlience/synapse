/** 主线程发往工作线程的消息 */
export type ShimmerWorkerMessage =
  | { type: 'update'; phase: string; phaseName: string; percent: number; count: number }
  | { type: 'finish-phase' }
  | { type: 'stop' };

/** 工作线程发往主线程的消息 */
export type ShimmerMainMessage =
  | { type: 'stopped' };
