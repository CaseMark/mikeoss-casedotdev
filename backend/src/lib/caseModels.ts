import { CaseClient, type CaseLlmConfigModel, type CaseModel } from "./caseClient";

export type CaseModelGroup = "Case.dev" | "Anthropic" | "OpenAI" | "Google" | "Other";

export type CaseModelOption = {
    id: string;
    label: string;
    group: CaseModelGroup;
    provider: string;
    description: string | null;
    pricing: Record<string, unknown> | null;
    source: "live" | "fallback";
};

export const FALLBACK_CASE_MODELS: CaseModelOption[] = [
    {
        id: "casemark/core-large",
        label: "CaseMark Core",
        group: "Case.dev",
        provider: "casemark",
        description: "Case.dev default legal model for Mike chat and document work.",
        pricing: null,
        source: "fallback",
    },
    {
        id: "anthropic/claude-sonnet-4.5",
        label: "Claude Sonnet",
        group: "Anthropic",
        provider: "anthropic",
        description: "Anthropic Claude routed through Case.dev.",
        pricing: null,
        source: "fallback",
    },
    {
        id: "openai/gpt-4o",
        label: "GPT-4o",
        group: "OpenAI",
        provider: "openai",
        description: "OpenAI GPT-4o routed through Case.dev.",
        pricing: null,
        source: "fallback",
    },
    {
        id: "google/gemini-1.5-pro",
        label: "Gemini Pro",
        group: "Google",
        provider: "google",
        description: "Google Gemini routed through Case.dev.",
        pricing: null,
        source: "fallback",
    },
];

function providerFromModelId(modelId: string, explicitProvider?: string | null): string {
    const provider = explicitProvider?.trim();
    if (provider) return provider.toLowerCase();
    if (modelId.includes("/")) return modelId.split("/")[0].toLowerCase();
    if (modelId.startsWith("gpt-")) return "openai";
    if (modelId.startsWith("claude-")) return "anthropic";
    if (modelId.startsWith("gemini-")) return "google";
    if (modelId.startsWith("casemark-")) return "casemark";
    return "other";
}

export function groupForCaseProvider(provider: string): CaseModelGroup {
    const normalized = provider.toLowerCase();
    if (normalized === "casemark" || normalized === "case" || normalized === "case.dev") {
        return "Case.dev";
    }
    if (normalized === "anthropic") return "Anthropic";
    if (normalized === "openai") return "OpenAI";
    if (normalized === "google" || normalized === "gemini") return "Google";
    return "Other";
}

function titleCaseToken(token: string): string {
    if (!token) return token;
    if (/^gpt/i.test(token)) return token.toUpperCase();
    return token.charAt(0).toUpperCase() + token.slice(1);
}

export function labelForCaseModel(modelId: string, name?: string | null): string {
    const trimmedName = name?.trim();
    if (trimmedName) return trimmedName;
    const withoutProvider = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
    return withoutProvider
        .split(/[-_/]+/)
        .filter(Boolean)
        .map(titleCaseToken)
        .join(" ");
}

export function normalizeCaseModelCatalog(
    models: CaseModel[],
    configModels: CaseLlmConfigModel[] = [],
): CaseModelOption[] {
    const configById = new Map(configModels.map((model) => [model.id, model]));
    const seen = new Set<string>();
    const options: CaseModelOption[] = [];

    for (const model of models) {
        if (!model.id || seen.has(model.id)) continue;
        seen.add(model.id);
        const config = configById.get(model.id);
        const provider = providerFromModelId(model.id, model.owned_by);
        options.push({
            id: model.id,
            label: labelForCaseModel(model.id, config?.name ?? model.name),
            group: groupForCaseProvider(provider),
            provider,
            description: config?.description ?? model.description ?? null,
            pricing: (config?.pricing ?? model.pricing ?? null) as Record<string, unknown> | null,
            source: "live",
        });
    }

    for (const config of configModels) {
        if (!config.id || seen.has(config.id)) continue;
        seen.add(config.id);
        const provider = providerFromModelId(config.id);
        options.push({
            id: config.id,
            label: labelForCaseModel(config.id, config.name),
            group: groupForCaseProvider(provider),
            provider,
            description: config.description ?? null,
            pricing: config.pricing ?? null,
            source: "live",
        });
    }

    return options.sort((a, b) => {
        const groupOrder = ["Case.dev", "Anthropic", "OpenAI", "Google", "Other"];
        const byGroup = groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
        if (byGroup !== 0) return byGroup;
        if (a.id === "casemark/core-large") return -1;
        if (b.id === "casemark/core-large") return 1;
        return a.label.localeCompare(b.label);
    });
}

export async function getCaseModelCatalog(apiKeyOrClient: string | CaseClient): Promise<CaseModelOption[]> {
    const client =
        typeof apiKeyOrClient === "string"
            ? new CaseClient(apiKeyOrClient)
            : apiKeyOrClient;
    const [models, config] = await Promise.all([
        client.listModels(),
        client.getLlmConfig().catch(() => ({ models: [] })),
    ]);
    const live = normalizeCaseModelCatalog(models, config.models);
    return live.length ? live : FALLBACK_CASE_MODELS;
}
