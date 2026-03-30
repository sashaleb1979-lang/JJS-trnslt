# Glossary Policy

- Local SQLite rules are the source of truth
- DeepL glossary artifacts are generated from local active rules
- Preserve-only terms stay untranslated
- Fixed terms always use the configured Russian target form

## Commands

### `/glossary add` — add a single rule

```
/glossary add source_term:<term> mode:<fixed|preserve> [target_term:<translation>] [source_lang:EN] [target_lang:RU]
```

- `mode=preserve` — keep the term untranslated (for character and skill names)
- `mode=fixed` — always translate the term to the given `target_term`

### `/glossary import` — bulk import (recommended for large glossaries)

Opens a Discord modal with a large textarea. Paste your full glossary payload and submit.

**Options (set before the modal opens):**

| Option | Default | Description |
|--------|---------|-------------|
| `source_lang` | guild default | Source language (e.g. `EN`) |
| `target_lang` | guild default | Target language (e.g. `RU`) |
| `dry_run` | `false` | Parse and validate only, no DB writes |
| `replace_existing` | `false` | If true, replace conflicting rules; if false, skip them |

**After submit the bot replies with a summary:**

```
Импорт glossary завершён.
Pair: EN -> RU
Parsed: 54
Added: 40
Updated: 8
Skipped: 6
Errors: 0
Active glossary version: glv_...
```

### `/glossary remove` — archive a rule

### `/glossary list` — list rules (with optional text filter)

### `/glossary preview` — preview how glossary rules affect a sample text

## Bulk Import Payload Format

The payload uses named sections separated by blank lines and optional `#` comments.

```
# jjs / jjk glossary

[characters]
Gojo
Sukuna
Yuta
Rika

[skills]
Black Flash
Root Swarm
Flower Field

[terms]
awakening = Awakening (пробуждение)
guard break = Guard Break (ломание блока)
cooldown = Cooldown (откат)
```

### Section semantics

| Section | Rule type | Effect |
|---------|-----------|--------|
| `[characters]` | `preserve` | Name stays untranslated |
| `[skills]` | `preserve` | Skill name stays untranslated |
| `[terms]` | `fixed` | Term is replaced with the given target form |

### Format rules

1. Lines starting with `#` are comments — ignored.
2. Empty lines are ignored.
3. `[characters]` and `[skills]`: each non-empty line is one `source_term` (mode=preserve).
4. `[terms]`: each line must be `source = target`. Leading/trailing whitespace is trimmed.
5. Duplicate `source_term` values within one payload are silently deduplicated (case-insensitive).
6. Outer code fences (` ``` `) are stripped automatically if present.

### Import logic

1. The full payload is parsed first.
2. Validation runs (guild setup, language pair, non-empty result).
3. All DB changes are applied in a **single transaction**.
4. DeepL glossary sync runs **once** for the whole batch.
5. Active glossary version is updated on all affected mappings.
6. A summary is returned.

### Error handling

- Parse errors report line number, content, and reason.
- Validation errors are shown before any DB changes are made.
- If `replace_existing=false` (default) and a rule already exists with different values, the new rule is **skipped** (not an error).
- If `replace_existing=true`, the existing rule is archived and the new version is added.
