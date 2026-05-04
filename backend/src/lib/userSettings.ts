import { createServerDb } from "./db";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    type UserApiKeys,
} from "./llm";
import { getEffectiveCaseApiKey } from "./caseCredentials";
import { getEffectiveProviderApiKeys } from "./providerCredentials";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerDb>,
): Promise<UserModelSettings> {
    const client = db ?? createServerDb();
    const { data } = await client
        .from("user_profiles")
        .select("tabular_model")
        .eq("user_id", userId)
        .single();

    const caseKey = await getEffectiveCaseApiKey(userId, client).catch((err) => {
        console.error("[userSettings] unable to load Case API key", err);
        return null;
    });
    const providerKeys = await getEffectiveProviderApiKeys(userId, client).catch((err) => {
        console.error("[userSettings] unable to load provider API keys", err);
        return { anthropic: null, gemini: null };
    });
    const api_keys: UserApiKeys = {
        case: caseKey?.apiKey ?? null,
        caseSource: caseKey?.source ?? null,
        caseUsageContext:
            caseKey?.source === "demo"
                ? {
                      userId,
                      db: client,
                      source: "demo",
                      service: "llm",
                      operation: "llm.request",
                  }
                : null,
        claude: providerKeys.anthropic?.apiKey ?? null,
        gemini: providerKeys.gemini?.apiKey ?? null,
    };

    return {
        title_model: DEFAULT_TITLE_MODEL,
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerDb>,
): Promise<UserApiKeys> {
    const client = db ?? createServerDb();
    const caseKey = await getEffectiveCaseApiKey(userId, client).catch((err) => {
        console.error("[userSettings] unable to load Case API key", err);
        return null;
    });
    const providerKeys = await getEffectiveProviderApiKeys(userId, client).catch((err) => {
        console.error("[userSettings] unable to load provider API keys", err);
        return { anthropic: null, gemini: null };
    });
    return {
        case: caseKey?.apiKey ?? null,
        caseSource: caseKey?.source ?? null,
        caseUsageContext:
            caseKey?.source === "demo"
                ? {
                      userId,
                      db: client,
                      source: "demo",
                      service: "llm",
                      operation: "llm.request",
                  }
                : null,
        claude: providerKeys.anthropic?.apiKey ?? null,
        gemini: providerKeys.gemini?.apiKey ?? null,
    };
}
