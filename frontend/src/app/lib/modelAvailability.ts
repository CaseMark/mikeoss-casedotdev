import { modelOptionsOrFallback, type ModelOption } from "./caseModels";

export type ModelProvider = "case" | "anthropic" | "gemini";

export type ModelProviderAvailability = {
    caseApiKeyConfigured: boolean;
    anthropicApiKeyConfigured?: boolean;
    geminiApiKeyConfigured?: boolean;
};

export function getModelProvider(modelId: string): ModelProvider | null {
    const id = modelId.trim();
    if (!id) return null;
    if (id.includes("/")) return "case";
    if (id.startsWith("claude")) return "anthropic";
    if (id.startsWith("gemini")) return "gemini";
    return "case";
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ModelProviderAvailability,
    models?: ModelOption[],
): boolean {
    const known =
        modelOptionsOrFallback(models).some((model) => model.id === modelId) ||
        modelId.includes("/") ||
        modelId.startsWith("claude") ||
        modelId.startsWith("gemini");
    const provider = getModelProvider(modelId);
    return known && !!provider && isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ModelProviderAvailability,
): boolean {
    if (provider === "case") return apiKeys.caseApiKeyConfigured;
    if (provider === "anthropic") return !!apiKeys.anthropicApiKeyConfigured;
    return !!apiKeys.geminiApiKeyConfigured;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "case") return "Case.dev";
    if (provider === "anthropic") return "Anthropic";
    return "Google Gemini";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "anthropic";
    if (group === "Google") return "gemini";
    return "case";
}
