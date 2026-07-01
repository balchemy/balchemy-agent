// src/tui/utils.ts — Shared utilities for the TUI layer

/** Map provider + baseUrl to a human-readable label. */
export function resolveProviderLabel(provider: string, baseUrl?: string): string {
  if (provider === "anthropic") return "anthropic";
  if (baseUrl?.includes("generativelanguage.googleapis.com")) return "gemini";
  if (baseUrl?.includes("api.x.ai")) return "grok";
  if (baseUrl?.includes("openrouter.ai")) return "openrouter";
  return "openai";
}
