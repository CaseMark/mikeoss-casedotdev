import { modelOptionsOrFallback, type ModelOption } from "./caseModels";
import type { ProviderCredentialStatus } from "./mikeApi";

export type ModelProvider = "case" | "anthropic" | "gemini";

export type ModelProviderAvailability = {
    caseApiKeyConfigured: boolean;
    anthropicApiKeyConfigured?: boolean;
    geminiApiKeyConfigured?: boolean;
};

export function isRecognizedModelId(
    modelId: string,
    models?: ModelOption[],
): boolean {
    const id = modelId.trim();
    return (
        !!id &&
        (modelOptionsOrFallback(models).some((model) => model.id === id) ||
            id.includes("/") ||
            id.startsWith("claude") ||
            id.startsWith("gemini"))
    );
}

export function providerCredentialState(
    caseApiKeyConfigured: boolean,
    providerCredentials?: ProviderCredentialStatus[] | null,
) {
    const anthropicStatus = providerCredentials?.find(
        (item) => item.provider === "anthropic",
    );
    const geminiStatus = providerCredentials?.find(
        (item) => item.provider === "gemini",
    );
    return {
        anthropicStatus,
        geminiStatus,
        apiKeys: {
            caseApiKeyConfigured,
            anthropicApiKeyConfigured: anthropicStatus?.configured ?? false,
            geminiApiKeyConfigured: geminiStatus?.configured ?? false,
        } satisfies ModelProviderAvailability,
    };
}

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
    const provider = getModelProvider(modelId);
    return (
        isRecognizedModelId(modelId, models) &&
        !!provider &&
        isProviderAvailable(provider, apiKeys)
    );
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
