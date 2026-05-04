import { modelOptionsOrFallback, type ModelOption } from "./caseModels";

export type ModelProvider = "case";

export function getModelProvider(modelId: string): ModelProvider | null {
    return modelId.trim() ? "case" : null;
}

export function isModelAvailable(
    modelId: string,
    apiKeys: { caseApiKeyConfigured: boolean },
    models?: ModelOption[],
): boolean {
    const known =
        modelOptionsOrFallback(models).some((model) => model.id === modelId) ||
        modelId.includes("/");
    return known && apiKeys.caseApiKeyConfigured;
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: { caseApiKeyConfigured: boolean },
): boolean {
    return provider === "case" && apiKeys.caseApiKeyConfigured;
}

export function providerLabel(provider: ModelProvider): string {
    void provider;
    return "Case.dev";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    void group;
    return "case";
}
