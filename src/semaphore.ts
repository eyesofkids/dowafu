// plan_dispatch_v1.4.md §9/§13：--concurrency 用信號量控制發起；429 等待期間 release()，
// 結束後重新 acquire()。release() 優先直接把名額交給排隊者，不經過 available 計數，
// 避免「release 後又被別人搶先 acquire」的競態窗口。

export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.available = max;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.available++;
  }
}
