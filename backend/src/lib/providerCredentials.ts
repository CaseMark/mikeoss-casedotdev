import type { createServerDb } from "./db";
import { decryptCaseApiKey, encryptCaseApiKey } from "./caseCredentials";
import { isDemoModeEnabled } from "./demoMode";
import {
    CLAUDE_MAIN_MODELS,
    CLAUDE_MID_MODELS,
    CLAUDE_LOW_MODELS,
    GEMINI_MAIN_MODELS,
    GEMINI_MID_MODELS,
    GEMINI_LOW_MODELS,
} from "./llm/models";
import type { CaseModelOption } from "./caseModels";
import { labelForCaseModel } from "./caseModels";

export type ProviderId = "anthropic" | "gemini";
export type ProviderCredentialSource = "user" | "server" | "demo" | "missing";

export type ProviderCredentialCapabilities = {
    llm: boolean;
    model_count: number | null;
};

export type ProviderCredentialStatus = {
    provider: ProviderId;
    label: string;
    configured: boolean;
    last4: string | null;
    status: "verified" | "unverified" | "invalid" | "missing";
    verified_at: string | null;
    last_checked_at: string | null;
    source: ProviderCredentialSource;
    capabilities: ProviderCredentialCapabilities;
    error: string | null;
};

export type EffectiveProviderApiKey = {
    provider: ProviderId;
    apiKey: string;
    source: "user" | "server";
};

type Db = ReturnType<typeof createServerDb>;

export const PROVIDERS: ProviderId[] = ["anthropic", "gemini"];

const EMPTY_CAPABILITIES: ProviderCredentialCapabilities = {
    llm: false,
    model_count: null,
};

export function providerLabel(provider: ProviderId): string {
    return provider === "anthropic" ? "Anthropic" : "Google Gemini";
}

function providerEnvKey(provider: ProviderId): string {
    return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
}

function serverProviderFallbackAllowed(): boolean {
    if (process.env.NODE_ENV === "production") return false;
    const configured = process.env.MIKE_ALLOW_SERVER_PROVIDER_KEY_FALLBACK
        ?.trim()
        .toLowerCase();
    if (configured === "true" || configured === "1" || configured === "yes") {
        return true;
    }
    return false;
}

function serverProviderKey(provider: ProviderId): string | null {
    if (!serverProviderFallbackAllowed()) return null;
    return process.env[providerEnvKey(provider)]?.trim() || null;
}

function normalizeCapabilities(raw: unknown): ProviderCredentialCapabilities {
    const value =
        raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
    return {
        llm: value.llm === true,
        model_count:
            typeof value.model_count === "number"
                ? value.model_count
                : typeof value.modelCount === "number"
                  ? value.modelCount
                  : null,
    };
}

function providerFromString(value: string | undefined): ProviderId | null {
    const normalized = value?.trim().toLowerCase();
    return normalized === "anthropic" || normalized === "gemini"
        ? normalized
        : null;
}

function last4(value: string) {
    return value.slice(-4);
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
    const response = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
    });
    if (!response.ok) {
        throw new Error(
            `Anthropic model validation failed with ${response.status}`,
        );
    }
    const json = (await response.json()) as { data?: { id?: string }[] };
    const models = (json.data ?? [])
        .map((model) => model.id)
        .filter((id): id is string => !!id);
    return models.length ? models : [...NATIVE_ANTHROPIC_MODELS];
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    );
    if (!response.ok) {
        throw new Error(`Gemini model validation failed with ${response.status}`);
    }
    const json = (await response.json()) as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    const models = (json.models ?? [])
        .filter((model) =>
            (model.supportedGenerationMethods ?? []).includes("generateContent"),
        )
        .map((model) => model.name?.replace(/^models\//, ""))
        .filter((id): id is string => !!id);
    return models.length ? models : [...NATIVE_GEMINI_MODELS];
}

const NATIVE_ANTHROPIC_MODELS = [
    ...new Set([
        ...CLAUDE_MAIN_MODELS,
        ...CLAUDE_MID_MODELS,
        ...CLAUDE_LOW_MODELS,
    ]),
];

const NATIVE_GEMINI_MODELS = [
    ...new Set([
        ...GEMINI_MAIN_MODELS,
        ...GEMINI_MID_MODELS,
        ...GEMINI_LOW_MODELS,
    ]),
];

export async function listProviderModels(
    provider: ProviderId,
    apiKey?: string | null,
): Promise<string[]> {
    if (apiKey) {
        return provider === "anthropic"
            ? listAnthropicModels(apiKey)
            : listGeminiModels(apiKey);
    }
    return provider === "anthropic"
        ? [...NATIVE_ANTHROPIC_MODELS]
        : [...NATIVE_GEMINI_MODELS];
}

export function nativeProviderModelOptions(
    provider: ProviderId,
    ids: string[],
    source: "live" | "fallback",
): CaseModelOption[] {
    const group = provider === "anthropic" ? "Anthropic" : "Google";
    return ids.map((id) => ({
        id,
        label: labelForCaseModel(id),
        group,
        provider,
        description:
            provider === "anthropic"
                ? "Anthropic model used with your encrypted Anthropic key."
                : "Gemini model used with your encrypted Google Gemini key.",
        pricing: null,
        source,
    }));
}

export async function validateProviderApiKey(
    provider: ProviderId,
    apiKey: string,
): Promise<ProviderCredentialCapabilities> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error(`${providerLabel(provider)} API key is required.`);
    const models = await listProviderModels(provider, trimmed).catch((err) => {
        throw new Error(
            `${providerLabel(provider)} validation failed: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    });
    return { llm: true, model_count: models.length };
}

export async function getProviderCredentialStatus(
    userId: string,
    provider: ProviderId,
    db: Db,
): Promise<ProviderCredentialStatus> {
    if (isDemoModeEnabled()) {
        return {
            provider,
            label: providerLabel(provider),
            configured: false,
            last4: null,
            status: "missing",
            verified_at: null,
            last_checked_at: null,
            source: "demo",
            capabilities: EMPTY_CAPABILITIES,
            error: "Demo mode uses the shared Case.dev key. External provider keys are disabled.",
        };
    }

    const { data } = await db
        .from("provider_api_credentials")
        .select("key_last4, status, verified_at, last_checked_at, capabilities, error")
        .eq("user_id", userId)
        .eq("provider", provider)
        .maybeSingle();

    if (data) {
        const status =
            data.status === "verified" ||
            data.status === "unverified" ||
            data.status === "invalid"
                ? data.status
                : "unverified";
        return {
            provider,
            label: providerLabel(provider),
            configured: status === "verified",
            last4: (data.key_last4 as string | null) ?? null,
            status,
            verified_at: (data.verified_at as string | null) ?? null,
            last_checked_at: (data.last_checked_at as string | null) ?? null,
            source: "user",
            capabilities: normalizeCapabilities(data.capabilities),
            error: (data.error as string | null) ?? null,
        };
    }

    const fallback = serverProviderKey(provider);
    if (fallback) {
        return {
            provider,
            label: providerLabel(provider),
            configured: true,
            last4: last4(fallback),
            status: "unverified",
            verified_at: null,
            last_checked_at: null,
            source: "server",
            capabilities: { llm: true, model_count: null },
            error: null,
        };
    }

    return {
        provider,
        label: providerLabel(provider),
        configured: false,
        last4: null,
        status: "missing",
        verified_at: null,
        last_checked_at: null,
        source: "missing",
        capabilities: EMPTY_CAPABILITIES,
        error: null,
    };
}

export async function getProviderCredentialStatuses(userId: string, db: Db) {
    return Promise.all(
        PROVIDERS.map((provider) =>
            getProviderCredentialStatus(userId, provider, db),
        ),
    );
}

export async function getUserProviderApiKey(
    userId: string,
    provider: ProviderId,
    db: Db,
): Promise<string | null> {
    const { data } = await db
        .from("provider_api_credentials")
        .select("encrypted_key, key_iv, key_tag, status")
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("status", "verified")
        .maybeSingle();
    if (!data) return null;
    return decryptCaseApiKey(data as {
        encrypted_key: string;
        key_iv: string;
        key_tag: string;
    });
}

export async function getEffectiveProviderApiKey(
    userId: string,
    provider: ProviderId,
    db: Db,
): Promise<EffectiveProviderApiKey | null> {
    if (isDemoModeEnabled()) return null;
    const userKey = await getUserProviderApiKey(userId, provider, db);
    if (userKey) return { provider, apiKey: userKey, source: "user" };
    const fallback = serverProviderKey(provider);
    if (fallback) return { provider, apiKey: fallback, source: "server" };
    return null;
}

export async function getEffectiveProviderApiKeys(userId: string, db: Db) {
    const [anthropic, gemini] = await Promise.all([
        getEffectiveProviderApiKey(userId, "anthropic", db),
        getEffectiveProviderApiKey(userId, "gemini", db),
    ]);
    return { anthropic, gemini };
}

export async function saveProviderApiKey(
    userId: string,
    rawProvider: string | undefined,
    apiKey: string,
    db: Db,
): Promise<ProviderCredentialStatus> {
    if (isDemoModeEnabled()) {
        throw new Error("Demo mode uses the shared Case.dev key. External provider keys are disabled.");
    }
    const provider = providerFromString(rawProvider);
    if (!provider) throw new Error("Unsupported provider.");
    const trimmed = apiKey.trim();
    const capabilities = await validateProviderApiKey(provider, trimmed);
    const encrypted = encryptCaseApiKey(trimmed);
    const now = new Date().toISOString();
    const { error } = await db.from("provider_api_credentials").upsert(
        {
            user_id: userId,
            provider,
            ...encrypted,
            key_last4: last4(trimmed),
            status: "verified",
            verified_at: now,
            last_checked_at: now,
            capabilities,
            error: null,
            revoked_at: null,
            updated_at: now,
        },
        { onConflict: "user_id, provider" },
    );
    if (error) throw new Error(error.message);
    return getProviderCredentialStatus(userId, provider, db);
}

export async function clearProviderApiKey(
    userId: string,
    rawProvider: string | undefined,
    db: Db,
): Promise<ProviderCredentialStatus> {
    if (isDemoModeEnabled()) {
        throw new Error("Demo mode uses the shared Case.dev key. External provider key changes are disabled.");
    }
    const provider = providerFromString(rawProvider);
    if (!provider) throw new Error("Unsupported provider.");
    const now = new Date().toISOString();
    await db
        .from("provider_api_credentials")
        .update({
            encrypted_key: "",
            key_iv: "",
            key_tag: "",
            status: "invalid",
            capabilities: EMPTY_CAPABILITIES,
            error: null,
            revoked_at: now,
            last_checked_at: now,
            updated_at: now,
        })
        .eq("user_id", userId)
        .eq("provider", provider);
    return getProviderCredentialStatus(userId, provider, db);
}
