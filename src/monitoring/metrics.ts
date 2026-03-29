import { RuntimeMetricsSnapshot } from "../domain/types";

export class MetricsService {
  private snapshot: RuntimeMetricsSnapshot = {
    jobsProcessedTotal: 0,
    translationSuccessTotal: 0,
    publishSuccessTotal: 0,
    retriesTotal: 0,
    failedJobsTotal: 0,
    duplicatesSuppressedTotal: 0,
    mediaMirrorFailuresTotal: 0,
    cumulativeBilledCharacters: 0,
    lastSuccessfulTranslationAt: null,
  };

  increment<K extends keyof RuntimeMetricsSnapshot>(key: K, delta = 1): void {
    const current = this.snapshot[key];
    if (typeof current === "number") {
      this.snapshot[key] = (current + delta) as RuntimeMetricsSnapshot[K];
    }
  }

  addBilledCharacters(value: number): void {
    this.snapshot.cumulativeBilledCharacters += value;
  }

  setLastSuccessfulTranslationAt(value: string): void {
    this.snapshot.lastSuccessfulTranslationAt = value;
  }

  getSnapshot(): RuntimeMetricsSnapshot {
    return { ...this.snapshot };
  }
}
