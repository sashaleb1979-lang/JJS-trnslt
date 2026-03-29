import { addSeconds, nowIso } from "../utils/time";

const RETRY_SCHEDULE = [60, 180, 600, 1800, 7200, 21600];

export function getRetryDelaySeconds(attemptCount: number, baseSeconds: number): number {
  if (attemptCount <= 0) {
    return baseSeconds;
  }

  const indexed = RETRY_SCHEDULE[Math.min(attemptCount - 1, RETRY_SCHEDULE.length - 1)];
  return Math.max(baseSeconds, indexed);
}

export function computeNextRetryAt(attemptCount: number, baseSeconds: number): string {
  return addSeconds(nowIso(), getRetryDelaySeconds(attemptCount, baseSeconds));
}
