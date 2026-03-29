export class PollingScheduler {
  private timer: NodeJS.Timeout | null = null;

  start(task: () => Promise<void> | void, intervalMs: number): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void task();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
