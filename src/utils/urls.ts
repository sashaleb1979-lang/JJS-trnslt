export function safeUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

export function isHttpUrl(value: string | null | undefined): boolean {
  return safeUrl(value) !== null;
}
