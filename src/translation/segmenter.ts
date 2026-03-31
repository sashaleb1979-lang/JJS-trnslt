import { CanonicalTextBlock, TranslationBatchItem, TranslationRequestPlan } from "../domain/types";
import { chunkText, hasMeaningfulText } from "../utils/text";
import { LocalGlossaryRule, protectText } from "./token-protector";

const MAX_BATCH_ITEMS = 40;
const MAX_BATCH_BYTES = 100 * 1024;
const MAX_SEGMENT_LENGTH = 1_500;

export class TranslationSegmenter {
  buildPlans(input: {
    textBlocks: CanonicalTextBlock[];
    sourceLang?: string;
    targetLang: string;
    glossaryId?: string;
    glossaryVersionId?: string;
    localGlossaryRules?: LocalGlossaryRule[];
    context: string;
  }): TranslationRequestPlan[] {
    const items = this.segmentBlocks(input.textBlocks, input.localGlossaryRules ?? []);
    if (items.length === 0) {
      return [];
    }

    const batches: TranslationRequestPlan[] = [];
    let currentItems: TranslationBatchItem[] = [];
    let currentBytes = 0;

    for (const item of items) {
      const size = Buffer.byteLength(item.text, "utf8");
      if (currentItems.length >= MAX_BATCH_ITEMS || currentBytes + size > MAX_BATCH_BYTES) {
        batches.push({
          items: currentItems,
          context: input.context,
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
          glossaryId: input.glossaryId,
          glossaryVersionId: input.glossaryVersionId,
        });
        currentItems = [];
        currentBytes = 0;
      }

      currentItems.push(item);
      currentBytes += size;
    }

    if (currentItems.length > 0) {
      batches.push({
        items: currentItems,
        context: input.context,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        glossaryId: input.glossaryId,
        glossaryVersionId: input.glossaryVersionId,
      });
    }

    return batches;
  }

  private segmentBlocks(blocks: CanonicalTextBlock[], localGlossaryRules: LocalGlossaryRule[]): TranslationBatchItem[] {
    const items: TranslationBatchItem[] = [];
    for (const block of blocks) {
      if (!hasMeaningfulText(block.source_text)) {
        continue;
      }

      const parts = chunkText(block.source_text, MAX_SEGMENT_LENGTH);
      if (parts.length === 0) {
        continue;
      }

      parts.forEach((part, index) => {
        const protectedResult = protectText(part, localGlossaryRules);
        items.push({
          blockId: parts.length > 1 ? `${block.block_id}:part:${index}` : block.block_id,
          originalText: part,
          text: protectedResult.protectedText,
          tokenMap: protectedResult.tokenMap,
          protectedTokens: Array.from(protectedResult.tokenMap.keys()),
          localGlossaryMatchCount: protectedResult.glossaryMatchCount,
        });
      });
    }
    return items;
  }
}
