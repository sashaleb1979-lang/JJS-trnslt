const URL_REGEX = /\bhttps?:\/\/[^\s<>()]+/gi;
const DIGIT_REGEX = /\d+/g;
const LETTER_REGEX = /\p{L}/u;

export function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function extractUrls(value: string): string[] {
  return Array.from(value.matchAll(URL_REGEX), (match) => match[0]);
}

export function hashSafeSummary(value: string, maxLength = 160): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3)}...`;
}

export function hasMeaningfulText(value: string): boolean {
  if (!value.trim()) {
    return false;
  }

  const withoutUrls = value.replace(URL_REGEX, "");
  return LETTER_REGEX.test(withoutUrls);
}

export function countNumericTokens(value: string): number {
  return (value.match(DIGIT_REGEX) ?? []).length;
}

export function chunkText(input: string, maxLength: number): string[] {
  if (input.length <= maxLength) {
    return [input];
  }

  const paragraphs = input.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const normalized = paragraph.trim();
    if (!normalized) {
      continue;
    }

    const candidate = current ? `${current}\n\n${normalized}` : normalized;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (normalized.length <= maxLength) {
      current = normalized;
      continue;
    }

    const lines = normalized.split("\n");
    let lineChunk = "";
    for (const line of lines) {
      const lineCandidate = lineChunk ? `${lineChunk}\n${line}` : line;
      if (lineCandidate.length <= maxLength) {
        lineChunk = lineCandidate;
        continue;
      }
      if (lineChunk) {
        chunks.push(lineChunk);
      }
      if (line.length <= maxLength) {
        lineChunk = line;
        continue;
      }

      let remaining = line;
      while (remaining.length > maxLength) {
        let slicePoint = remaining.lastIndexOf(" ", maxLength);
        if (slicePoint < Math.floor(maxLength * 0.6)) {
          slicePoint = maxLength;
        }
        chunks.push(remaining.slice(0, slicePoint).trim());
        remaining = remaining.slice(slicePoint).trim();
      }
      lineChunk = remaining;
    }

    current = lineChunk;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter(Boolean);
}

export function stripCodeBlocks(value: string): string {
  return value.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
}

export function sanitizeForDiscord(value: string): string {
  return value.replace(/@everyone/g, "@\u200beveryone").replace(/@here/g, "@\u200bhere");
}

export function buildGlossaryEntriesFromRules(
  rules: Array<{ sourceTerm: string; targetTerm: string | null; ruleType: "fixed" | "preserve" }>,
): string {
  return rules
    .map((rule) => `${rule.sourceTerm}\t${rule.ruleType === "preserve" ? rule.sourceTerm : rule.targetTerm ?? rule.sourceTerm}`)
    .join("\n");
}
