import crypto from "crypto";
import type { createServerDb } from "./db";
import { CaseClient } from "./caseClient";
import { demoCaseApiKey, isDemoModeEnabled } from "./demoMode";
import type { DemoUsageService } from "./demoUsage";

const ALGORITHM = "aes-256-gcm";

export type CaseCredentialCapabilities = {
    llm: boolean;
    vault: boolean;
    skills: boolean;
    matters: boolean;
    legal: boolean;
    model_count: number | null;
};

export type CaseCredentialStatus = {
    configured: boolean;
    last4: string | null;
    status: "verified" | "unverified" | "invalid" | "missing";
    verified_at: string | null;
    last_checked_at: string | null;
    source: "user" | "server" | "demo" | "missing";
    capabilities: CaseCredentialCapabilities;
    error: string | null;
};

export type EffectiveCaseApiKey = {
    apiKey: string;
    source: "user" | "server" | "demo";
};

type Db = ReturnType<typeof createServerDb>;

const EMPTY_CAPABILITIES: CaseCredentialCapabilities = {
    llm: false,
    vault: false,
    skills: false,
    matters: false,
    legal: false,
    model_count: null,
};

function serverCaseApiKey(): string | null {
    return process.env.CASE_API_KEY?.trim() || null;
}

function serverKeyFallbackAllowed(): boolean {
    const configured = process.env.CASE_ALLOW_SERVER_KEY_FALLBACK?.trim().toLowerCase();
    if (configured === "true" || configured === "1" || configured === "yes") return true;
    if (configured === "false" || configured === "0" || configured === "no") return false;
    return process.env.NODE_ENV !== "production";
}

function serverFallbackKey(): string | null {
    if (!serverKeyFallbackAllowed()) return null;
    return serverCaseApiKey();
}

function normalizeCapabilities(raw: unknown): CaseCredentialCapabilities {
    const value =
        raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
    return {
        llm: value.llm === true,
        vault: value.vault === true,
        skills: value.skills === true,
        matters: value.matters === true,
        legal: value.legal === true,
        model_count:
            typeof value.model_count === "number"
                ? value.model_count
                : typeof value.modelCount === "number"
                  ? value.modelCount
                  : null,
    };
}

function encryptionKey(): Buffer {
    const secret = process.env.CASE_KEY_ENCRYPTION_SECRET?.trim();
    if (!secret) {
        throw new Error("CASE_KEY_ENCRYPTION_SECRET is required to store Case.dev API keys.");
    }
    if (/^[A-Za-z0-9_-]{43,}$/.test(secret)) {
        try {
            const normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
            const raw = Buffer.from(normalized, "base64");
            if (raw.length === 32) return raw;
        } catch {
            /* fall through to hash derivation */
        }
    }
    return crypto.createHash("sha256").update(secret).digest();
}

export function encryptCaseApiKey(apiKey: string): {
    encrypted_key: string;
    key_iv: string;
    key_tag: string;
} {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(apiKey, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted_key: encrypted.toString("base64"),
        key_iv: iv.toString("base64"),
        key_tag: cipher.getAuthTag().toString("base64"),
    };
}

export function decryptCaseApiKey(row: {
    encrypted_key: string;
    key_iv: string;
    key_tag: string;
}): string {
    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        encryptionKey(),
        Buffer.from(row.key_iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(row.key_tag, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(row.encrypted_key, "base64")),
        decipher.final(),
    ]).toString("utf8");
}

export async function getCaseCredentialStatus(
    userId: string,
    db: Db,
): Promise<CaseCredentialStatus> {
    const { data } = await db
        .from("case_api_credentials")
        .select("key_last4, status, verified_at, last_checked_at, capabilities, error")
        .eq("user_id", userId)
        .maybeSingle();

    if (!data) {
        const demoKey = isDemoModeEnabled() ? demoCaseApiKey() : null;
        if (demoKey) {
            const checkedAt = new Date().toISOString();
            return {
                configured: true,
                last4: null,
                status: "verified",
                verified_at: checkedAt,
                last_checked_at: checkedAt,
                source: "demo",
                capabilities: {
                    llm: true,
                    vault: true,
                    skills: true,
                    matters: true,
                    legal: true,
                    model_count: null,
                },
                error: null,
            };
        }

        const fallback = serverFallbackKey();
        if (fallback) {
            try {
                const capabilities = await validateCaseApiKey(fallback);
                const checkedAt = new Date().toISOString();
                return {
                    configured: true,
                    last4: fallback.slice(-4),
                    status: "verified",
                    verified_at: checkedAt,
                    last_checked_at: checkedAt,
                    source: "server",
                    capabilities,
                    error: null,
                };
            } catch (err) {
                return {
                    configured: false,
                    last4: fallback.slice(-4),
                    status: "invalid",
                    verified_at: null,
                    last_checked_at: new Date().toISOString(),
                    source: "server",
                    capabilities: EMPTY_CAPABILITIES,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }
        return {
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

    const status =
        data.status === "verified" ||
        data.status === "unverified" ||
        data.status === "invalid"
            ? data.status
            : "unverified";

    return {
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

export async function getUserCaseApiKey(
    userId: string,
    db: Db,
): Promise<string | null> {
    const { data } = await db
        .from("case_api_credentials")
        .select("encrypted_key, key_iv, key_tag, status")
        .eq("user_id", userId)
        .eq("status", "verified")
        .maybeSingle();
    if (!data) return null;
    return decryptCaseApiKey(data as {
        encrypted_key: string;
        key_iv: string;
        key_tag: string;
    });
}

export async function getEffectiveCaseApiKey(
    userId: string,
    db: Db,
): Promise<EffectiveCaseApiKey | null> {
    const userKey = await getUserCaseApiKey(userId, db);
    if (userKey) return { apiKey: userKey, source: "user" };
    const demoKey = isDemoModeEnabled() ? demoCaseApiKey() : null;
    if (demoKey) return { apiKey: demoKey, source: "demo" };
    const fallback = serverFallbackKey();
    if (fallback) return { apiKey: fallback, source: "server" };
    return null;
}

export async function validateCaseApiKey(
    apiKey: string,
): Promise<CaseCredentialCapabilities> {
    const trimmed = apiKey.trim();
    if (!trimmed.startsWith("sk_case_")) {
        throw new Error("Case.dev API keys must start with sk_case_.");
    }
    const client = new CaseClient(trimmed);
    const models = await client.listModels().catch((err) => {
        throw new Error(
            `Case.dev LLM validation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    });
    await client.listVaults().catch((err) => {
        throw new Error(
            `Case.dev Vault validation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    });
    await client.searchSkills({ query: "contract review", limit: 1 }).catch((err) => {
        throw new Error(
            `Case.dev Skills validation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    });
    await client.listMatters({ limit: 1 }).catch((err) => {
        throw new Error(
            `Case.dev Matters validation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    });
    await client.legalListCourts({ limit: 1 }).catch((err) => {
        throw new Error(
            `Case.dev Legal validation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    });
    return {
        llm: true,
        vault: true,
        skills: true,
        matters: true,
        legal: true,
        model_count: models.length,
    };
}

export async function saveCaseApiKey(
    userId: string,
    apiKey: string,
    db: Db,
): Promise<CaseCredentialStatus> {
    const trimmed = apiKey.trim();
    const capabilities = await validateCaseApiKey(trimmed);
    const encrypted = encryptCaseApiKey(trimmed);
    const now = new Date().toISOString();
    const last4 = trimmed.slice(-4);
    const { error } = await db.from("case_api_credentials").upsert(
        {
            user_id: userId,
            ...encrypted,
            key_last4: last4,
            status: "verified",
            verified_at: now,
            last_checked_at: now,
            capabilities,
            error: null,
            updated_at: now,
        },
        { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return {
        configured: true,
        last4,
        status: "verified",
        verified_at: now,
        last_checked_at: now,
        source: "user",
        capabilities,
        error: null,
    };
}

export async function clearCaseApiKey(
    userId: string,
    db: Db,
): Promise<CaseCredentialStatus> {
    await db.from("case_api_credentials").delete().eq("user_id", userId);
    return getCaseCredentialStatus(userId, db);
}

export function caseClientForEffectiveKey(
    effective: EffectiveCaseApiKey,
    params: {
        userId: string;
        db: Db;
        service: DemoUsageService;
        operation: string;
    },
): CaseClient {
    return new CaseClient(effective.apiKey, {
        usage:
            effective.source === "demo"
                ? {
                      userId: params.userId,
                      db: params.db,
                      source: "demo",
                      service: params.service,
                      operation: params.operation,
                  }
                : undefined,
    });
}
