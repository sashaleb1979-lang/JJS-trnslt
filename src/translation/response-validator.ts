import { AppError } from "../domain/errors";
import { countNumericTokens } from "../utils/text";
import { restoreProtectedText } from "./token-protector";

export class TranslationResponseValidator {
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
        message: "Protected token count dropped after translation",
        retryable: true,
      });
    }

    if (countNumericTokens(translatedText) + 3 < countNumericTokens(originalText)) {
      throw new AppError({
        code: "TRANSLATION_NUMERIC_MISMATCH",
        message: "Numeric tokens were lost during translation",
        retryable: true,
      });
    }

    return restoreProtectedText(translatedText, tokenMap);
  }
}
