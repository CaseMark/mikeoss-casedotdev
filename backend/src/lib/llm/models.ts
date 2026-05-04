import type { Provider } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Case.dev model IDs are OpenAI-style gateway IDs. Keep a small built-in
// catalog for offline UI/defaults; the backend can still accept any
// provider/model ID returned by Case's live /llm/v1/models catalog.
export const CASE_MAIN_MODELS = [
    "casemark/core-large",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-4o",
    "google/gemini-1.5-pro",
] as const;
export const CASE_MID_MODELS = [
    "casemark/core-large",
    "openai/gpt-4o",
] as const;
export const CASE_LOW_MODELS = ["casemark/core-large"] as const;

// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6"] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-4-6"] as const;
export const GEMINI_MID_MODELS = ["gemini-3-flash-preview"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;

export const DEFAULT_MAIN_MODEL =
    process.env.CASE_DEFAULT_MAIN_MODEL ?? "casemark/core-large";
export const DEFAULT_TITLE_MODEL =
    process.env.CASE_DEFAULT_TITLE_MODEL ?? DEFAULT_MAIN_MODEL;
export const DEFAULT_TABULAR_MODEL =
    process.env.CASE_DEFAULT_TABULAR_MODEL ?? DEFAULT_MAIN_MODEL;

const ALL_MODELS = new Set<string>([
    ...CASE_MAIN_MODELS,
    ...CASE_MID_MODELS,
    ...CASE_LOW_MODELS,
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (model.startsWith("casemark/") || model.includes("/")) return "case";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    throw new Error(`Unknown model id: ${model}`);
}

export function resolveModel(id: string | null | undefined, fallback: string): string {
    if (id && ALL_MODELS.has(id)) return id;
    if (id && (id.startsWith("casemark/") || id.includes("/"))) return id;
    return fallback;
}
