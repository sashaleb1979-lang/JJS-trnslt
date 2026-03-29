export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(isoString: string, seconds: number): string {
  return new Date(new Date(isoString).getTime() + seconds * 1000).toISOString();
}

export function diffSeconds(startIso: string, endIso: string): number {
  return Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
}
