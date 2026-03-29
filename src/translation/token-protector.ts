import { countNumericTokens } from "../utils/text";

export interface ProtectedTextResult {
  protectedText: string;
  tokenMap: Map<string, string>;
  tokenCount: number;
  numericTokenCount: number;
}

const PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /\bhttps?:\/\/[^\s<>()]+/gi,
  /<@[!&]?\d+>/g,
  /<#\d+>/g,
  /<a?:[a-zA-Z0-9_]+:\d+>/g,
  /\/[a-z0-9_-]+/gi,
];

export function protectText(input: string): ProtectedTextResult {
  let protectedText = input;
  const tokenMap = new Map<string, string>();
  let tokenIndex = 0;

  for (const pattern of PATTERNS) {
    protectedText = protectedText.replace(pattern, (match) => {
      const token = `__BOT_TOKEN_${tokenIndex++}__`;
      tokenMap.set(token, match);
      return token;
    });
  }

  return {
    protectedText,
    tokenMap,
    tokenCount: tokenMap.size,
    numericTokenCount: countNumericTokens(input),
  };
}

export function restoreProtectedText(input: string, tokenMap: Map<string, string>): string {
  let restored = input;
  for (const [token, original] of tokenMap.entries()) {
    restored = restored.replaceAll(token, original);
  }
  return restored;
}
