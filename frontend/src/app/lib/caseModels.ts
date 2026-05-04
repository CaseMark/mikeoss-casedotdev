export type CaseModelGroup = "Case.dev" | "Anthropic" | "OpenAI" | "Google" | "Other";

export interface ModelOption {
    id: string;
    label: string;
    group: CaseModelGroup;
    provider?: string;
    description?: string | null;
    pricing?: Record<string, unknown> | null;
    source?: "live" | "fallback";
}

export const DEFAULT_MODEL_ID = "casemark/core-large";

export const FALLBACK_CASE_MODELS: ModelOption[] = [
    {
        id: DEFAULT_MODEL_ID,
        label: "CaseMark Core",
        group: "Case.dev",
        provider: "casemark",
        description: "Case.dev default legal model for Mike chat and document work.",
        source: "fallback",
    },
    {
        id: "anthropic/claude-sonnet-4.5",
        label: "Claude Sonnet",
        group: "Anthropic",
        provider: "anthropic",
        description: "Anthropic Claude routed through Case.dev.",
        source: "fallback",
    },
    {
        id: "openai/gpt-4o",
        label: "GPT-4o",
        group: "OpenAI",
        provider: "openai",
        description: "OpenAI GPT-4o routed through Case.dev.",
        source: "fallback",
    },
    {
        id: "google/gemini-1.5-pro",
        label: "Gemini Pro",
        group: "Google",
        provider: "google",
        description: "Google Gemini routed through Case.dev.",
        source: "fallback",
    },
];

export const GROUP_ORDER: CaseModelGroup[] = [
    "Case.dev",
    "Anthropic",
    "OpenAI",
    "Google",
    "Other",
];

export function modelOptionsOrFallback(models?: ModelOption[] | null): ModelOption[] {
    return models?.length ? models : FALLBACK_CASE_MODELS;
}

export function findModelOption(
    modelId: string,
    models?: ModelOption[] | null,
): ModelOption | undefined {
    return modelOptionsOrFallback(models).find((model) => model.id === modelId);
}
