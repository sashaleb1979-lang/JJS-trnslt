import { AppError } from "../domain/errors";
import { countNumericTokens } from "../utils/text";
import { restoreProtectedText } from "./token-protector";

export class TranslationResponseValidator {
  // These checks are conservative and only guard against obviously broken responses.
  validateAndRestore(input: { originalText: string; translatedText: string; tokenMap: Map<string, string> }): string {
    const { originalText, translatedText, tokenMap } = input;
    if (!translatedText.trim()) {
      throw new AppError({
        code: "TRANSLATION_EMPTY",
        message: "DeepL returned an empty translation result",
        retryable: true,
      });
    }

    const translatedTokenCount = Array.from(tokenMap.keys()).filter((token) => translatedText.includes(token)).length;
    if (translatedTokenCount < tokenMap.size) {
      throw new AppError({
        code: "TRANSLATION_TOKEN_MISMATCH",
        message: `Protected token count dropped after translation (expected ${tokenMap.size}, got ${translatedTokenCount})`,
        retryable: false,
        details: {
          expectedTokenCount: tokenMap.size,
          actualTokenCount: translatedTokenCount,
        },
      });
    }

    const originalNumerics = countNumericTokens(originalText);
    const translatedNumerics = countNumericTokens(translatedText);
    if (originalNumerics > 0 && translatedNumerics < originalNumerics * 0.4) {
      throw new AppError({
        code: "TRANSLATION_NUMERIC_MISMATCH",
        message: `Too many numeric tokens were lost during translation (original: ${originalNumerics}, translated: ${translatedNumerics})`,
        retryable: false,
        details: {
          originalNumerics,
          translatedNumerics,
        },
      });
    }

    return restoreProtectedText(translatedText, tokenMap);
  }
}
