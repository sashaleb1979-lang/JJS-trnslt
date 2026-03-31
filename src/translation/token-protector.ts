import { countNumericTokens } from "../utils/text";

export interface ProtectedTextResult {
  protectedText: string;
  tokenMap: Map<string, string>;
  tokenCount: number;
  numericTokenCount: number;
  glossaryMatchCount: number;
}

export interface LocalGlossaryRule {
  sourceTerm: string;
  targetTerm: string | null;
  ruleType: "fixed" | "preserve";
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

export function protectText(input: string, glossaryRules: LocalGlossaryRule[] = []): ProtectedTextResult {
  let protectedText = input;
  const tokenMap = new Map<string, string>();
  let tokenIndex = 0;
  let glossaryMatchCount = 0;

  if (glossaryRules.length > 0) {
    const sortedRules = [...glossaryRules].sort((left, right) => right.sourceTerm.length - left.sourceTerm.length);
    for (const rule of sortedRules) {
      const sourceTerm = rule.sourceTerm.trim();
      if (!sourceTerm) {
        continue;
      }

      const escaped = escapeRegExp(sourceTerm);
      const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, "giu");
      protectedText = protectedText.replace(pattern, (match, prefix: string, matchedTerm: string) => {
        const token = `__BOT_TOKEN_${tokenIndex++}__`;
        tokenMap.set(token, rule.ruleType === "preserve" ? matchedTerm : (rule.targetTerm ?? matchedTerm));
        glossaryMatchCount += 1;
        return `${prefix}${token}`;
      });
    }
  }

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
    glossaryMatchCount,
  };
}

export function restoreProtectedText(input: string, tokenMap: Map<string, string>): string {
  let restored = input;
  for (const [token, original] of tokenMap.entries()) {
    restored = restored.replaceAll(token, original);
  }
  return restored;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
