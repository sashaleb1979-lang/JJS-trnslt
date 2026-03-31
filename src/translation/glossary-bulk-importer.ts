import { GlossaryRuleType } from "../domain/enums";

export interface BulkImportEntry {
  sourceTerm: string;
  mode: GlossaryRuleType;
  targetTerm: string | null;
}

export interface BulkImportParseError {
  lineNo: number;
  content: string;
  reason: string;
}

export interface BulkImportParseResult {
  entries: BulkImportEntry[];
  errors: BulkImportParseError[];
}

export interface BulkImportSummary {
  parsed: number;
  added: number;
  updated: number;
  skipped: number;
  errors: number;
  activeGlossaryVersionId: string | null;
}

type Section = "characters" | "skills" | "terms";

const BULLET_PREFIX_REGEX = /^[-*•]+\s*/;

/**
 * Parse a bulk glossary import payload.
 *
 * Supported format:
 *
 * ```
 * # optional comment
 *
 * [characters]
 * Gojo
 * Sukuna
 *
 * [skills]
 * Black Flash
 *
 * [terms]
 * awakening = Awakening (пробуждение)
 * guard break = Guard Break (ломание блока)
 * ```
 *
 * Rules:
 * - Outer code fences (``` ... ```) are stripped automatically.
 * - Empty lines and lines starting with # are ignored.
 * - [characters] and [skills] produce mode=preserve, target_term=null entries.
 * - [terms] lines must have the format: source = target.
 * - Duplicates within the payload are deduplicated (case-insensitive on source_term).
 */
export function parseBulkGlossaryPayload(raw: string): BulkImportParseResult {
  const entries: BulkImportEntry[] = [];
  const errors: BulkImportParseError[] = [];

  // Strip optional outer code fences (``` or ```text etc.)
  let text = raw;
  text = text.replace(/^```[^\n]*\n/, "").replace(/\n```\s*$/, "");

  // Normalize line endings
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let currentSection: Section | null = null;
  const seen = new Set<string>(); // lowercased source_term for dedup

  const parseAsPreserve = (value: string, lineNo: number, content: string) => {
    const sourceTerm = value.trim();
    if (!sourceTerm) {
      return;
    }

    const key = sourceTerm.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    entries.push({ sourceTerm, mode: "preserve", targetTerm: null });
  };

  const parseAsFixed = (value: string, lineNo: number, content: string) => {
    const arrowIdx = value.includes("=>") ? value.indexOf("=>") : value.indexOf("=");
    if (arrowIdx === -1) {
      errors.push({
        lineNo,
        content,
        reason: "Отсутствует знак = (ожидается формат: source = target)",
      });
      return;
    }

    const sourceTerm = value.slice(0, arrowIdx).trim();
    const targetTerm = value.slice(arrowIdx + (value.includes("=>") ? 2 : 1)).trim();

    if (!sourceTerm) {
      errors.push({
        lineNo,
        content,
        reason: "source_term пустой (левая часть от =)",
      });
      return;
    }

    if (!targetTerm) {
      errors.push({
        lineNo,
        content,
        reason: "target_term пустой (правая часть от =)",
      });
      return;
    }

    const key = sourceTerm.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    entries.push({ sourceTerm, mode: "fixed", targetTerm });
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();

    // Skip empty lines
    if (!line) continue;

    // Skip comments
    if (line.startsWith("#") || line.startsWith("//")) continue;

    // Section header
    const sectionMatch = /^\[(\w+)\]$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1].toLowerCase().trim();
      if (name === "characters" || name === "skills" || name === "terms") {
        currentSection = name;
      } else {
        errors.push({
          lineNo,
          content: line,
          reason: `Неизвестная секция: [${sectionMatch[1]}]. Поддерживаются: [characters], [skills], [terms]`,
        });
      }
      continue;
    }

    const normalizedLine = line.replace(BULLET_PREFIX_REGEX, "").trim();
    if (!normalizedLine) {
      continue;
    }

    if (currentSection === "characters" || currentSection === "skills") {
      parseAsPreserve(normalizedLine, lineNo, line);
    } else if (currentSection === "terms") {
      parseAsFixed(normalizedLine, lineNo, line);
    } else {
      // Practical mode: sections are optional.
      if (normalizedLine.includes("=") || normalizedLine.includes("=>")) {
        parseAsFixed(normalizedLine, lineNo, line);
      } else {
        parseAsPreserve(normalizedLine, lineNo, line);
      }
    }
  }

  return { entries, errors };
}

/** Format a list of parse errors into a user-readable string (capped at maxErrors). */
export function formatParseErrors(errors: BulkImportParseError[], maxErrors = 10): string {
  const shown = errors.slice(0, maxErrors);
  const lines = shown.map((e) => `  Строка ${e.lineNo}: "${e.content}" — ${e.reason}`);
  if (errors.length > maxErrors) {
    lines.push(`  ...и ещё ${errors.length - maxErrors} ошибок`);
  }
  return lines.join("\n");
}
