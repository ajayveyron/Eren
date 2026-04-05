import type { LanguageModel } from "ai";

export type ErenProvider = "google-vertex" | "anthropic" | "openai";

/**
 * Returns a LanguageModel from the configured provider.
 * Uses dynamic import() since the package runs as ESM.
 */
export async function getLanguageModel(): Promise<LanguageModel> {
  const provider = (process.env.EREN_PROVIDER ?? "google-vertex") as ErenProvider;
  const modelId = process.env.EREN_MODEL;

  switch (provider) {
    case "google-vertex": {
      const { createVertex } = await import("@ai-sdk/google-vertex");
      const vertex = createVertex({
        project: process.env.GOOGLE_CLOUD_PROJECT,
        location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1"
      });
      return vertex(modelId ?? "gemini-2.5-flash");
    }

    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      return anthropic(modelId ?? "claude-sonnet-4-20250514");
    }

    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
      return openai(modelId ?? "gpt-4o");
    }

    default:
      throw new Error(`Unsupported EREN_PROVIDER: ${provider}. Use google-vertex, anthropic, or openai.`);
  }
}
