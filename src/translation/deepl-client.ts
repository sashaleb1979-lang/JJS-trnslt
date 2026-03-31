import { AppError } from "../domain/errors";
import { AppConfig, DeepLSupportedGlossaryPair, DeepLTranslateResponse, TranslationRequestPlan } from "../domain/types";

interface DeepLTranslateRequest {
  text: string[];
  source_lang: string;
  target_lang: string;
  context: string;
  model_type: string;
  show_billed_characters: boolean;
  glossary_id?: string;
}

export class DeepLClient {
  constructor(private readonly config: AppConfig) {}

  // Startup auth check uses usage because it is cheap and does not bill translation quota.
  async validateAuth(): Promise<void> {
    if (this.config.mockDeepl) {
      return;
    }
    const response = await this.request("/v2/usage", { method: "GET" });
    if (!response.ok) {
      throw await this.toAppError(response, "DEEPL_AUTH_INVALID", false);
    }
  }

  async getSupportedGlossaryPairs(): Promise<DeepLSupportedGlossaryPair[]> {
    if (this.config.mockDeepl) {
      return [{ source_lang: "EN", target_lang: "RU" }];
    }

    const response = await this.request("/v2/glossary-language-pairs", { method: "GET" });
    if (!response.ok) {
      throw await this.toAppError(response, "DEEPL_GLOSSARY_PAIR_FETCH_FAILED", false);
    }

    const data = (await response.json()) as { supported_languages?: DeepLSupportedGlossaryPair[] };
    return data.supported_languages ?? [];
  }

  async translate(plan: TranslationRequestPlan): Promise<DeepLTranslateResponse> {
    if (this.config.mockDeepl) {
      return {
        translations: plan.items.map((item) => ({
          detected_source_language: plan.sourceLang,
          text: `[RU] ${item.text}`,
          billed_characters: item.text.length,
        })),
      };
    }

    const payload: DeepLTranslateRequest = {
      text: plan.items.map((item) => item.text),
      source_lang: plan.sourceLang,
      target_lang: plan.targetLang,
      context: plan.context,
      model_type: "quality_optimized",
      show_billed_characters: true,
    };

    if (plan.glossaryId) {
      payload.glossary_id = plan.glossaryId;
    }

    const response = await this.request("/v2/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw await this.toAppError(response, "DEEPL_TRANSLATE_FAILED", response.status >= 500 || response.status === 429);
    }

    return (await response.json()) as DeepLTranslateResponse;
  }

  async createGlossary(input: {
    name: string;
    sourceLang: string;
    targetLang: string;
    entriesTsv: string;
  }): Promise<{ glossaryId: string }> {
    if (this.config.mockDeepl) {
      return { glossaryId: `mock-${input.sourceLang.toLowerCase()}-${input.targetLang.toLowerCase()}` };
    }

    const response = await this.request("/v3/glossaries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        dictionaries: [
          {
            source_lang: input.sourceLang.toLowerCase(),
            target_lang: input.targetLang.toLowerCase(),
            entries: input.entriesTsv,
            entries_format: "tsv",
          },
        ],
      }),
    });

    if (!response.ok) {
      throw await this.toAppError(response, "DEEPL_GLOSSARY_CREATE_FAILED", false);
    }

    const data = (await response.json()) as { glossary_id: string };
    return { glossaryId: data.glossary_id };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `DeepL-Auth-Key ${this.config.deeplApiKey}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      return await fetch(`${this.config.deeplApiBaseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      throw new AppError({
        code: "DEEPL_NETWORK_ERROR",
        message: "Failed to contact DeepL",
        retryable: true,
        details: { path },
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async toAppError(response: Response, code: string, retryable: boolean): Promise<AppError> {
    const text = await response.text();
    return new AppError({
      code,
      message: `DeepL request failed with status ${response.status}`,
      retryable,
      failureClass: retryable ? "transient" : response.status >= 500 ? "transient" : "permanent_config",
      details: { status: response.status, body: text.slice(0, 300) },
    });
  }
}
