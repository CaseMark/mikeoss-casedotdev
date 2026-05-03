"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
    getUserProfile,
    updateUserProfile,
    getCaseModelCatalog,
    getCaseApiKeyStatus,
    saveCaseApiKey,
    type CaseModelCatalog,
    type CaseApiKeyStatus,
} from "@/app/lib/mikeApi";
import {
    FALLBACK_CASE_MODELS,
    type ModelOption,
} from "@/app/lib/caseModels";

const DEFAULT_CASE_KEY_STATUS: CaseApiKeyStatus = {
    configured: false,
    last4: null,
    status: "missing",
    verified_at: null,
    last_checked_at: null,
    source: "missing",
    capabilities: {
        llm: false,
        vault: false,
        skills: false,
        model_count: null,
    },
    error: null,
};

const DEFAULT_CASE_MODEL_CATALOG: CaseModelCatalog = {
    source: "fallback",
    key_source: "missing",
    models: FALLBACK_CASE_MODELS,
};

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    tabularModel: string;
    caseApiKey: CaseApiKeyStatus;
    caseModels: ModelOption[];
    caseModelCatalog: Omit<CaseModelCatalog, "models">;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateCaseApiKey: (
        value: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async () => {
        try {
            // Define credit limit constant
            const MONTHLY_CREDIT_LIMIT = 999999; // temporarily unlimited

            const caseApiKey = await getCaseApiKeyStatus().catch(
                () => DEFAULT_CASE_KEY_STATUS,
            );
            const caseCatalog = await getCaseModelCatalog().catch(
                () => DEFAULT_CASE_MODEL_CATALOG,
            );
            const caseModels = caseCatalog.models.length
                ? caseCatalog.models
                : FALLBACK_CASE_MODELS;
            const caseModelCatalog = {
                source: caseCatalog.source,
                key_source: caseCatalog.key_source,
                error: caseCatalog.error,
            };

            const data = await getUserProfile();

            // Use fetched data to update profile state
            if (data) {
                let creditsUsed = data.message_credits_used;
                let resetDate = data.credits_reset_date;
                let creditsRemaining = MONTHLY_CREDIT_LIMIT - creditsUsed;
                let shouldUpdateDb = false;

                // Check if credits have expired and need reset
                if (resetDate && new Date() > new Date(resetDate)) {
                    // Calculate new reset date
                    const newResetDate = new Date();
                    newResetDate.setDate(newResetDate.getDate() + 30);
                    resetDate = newResetDate.toISOString();
                    creditsUsed = 0;
                    creditsRemaining = MONTHLY_CREDIT_LIMIT;
                    shouldUpdateDb = true;
                }

                // 1. Update local state immediately
                setProfile({
                    displayName: data.display_name,
                    organisation: data.organisation ?? null,
                    messageCreditsUsed: creditsUsed,
                    creditsResetDate: resetDate,
                    creditsRemaining: creditsRemaining,
                    tier: data.tier || "Free",
                    tabularModel:
                        data.tabular_model || "casemark/core-large",
                    caseApiKey,
                    caseModels,
                    caseModelCatalog,
                });

                // 2. Update database in background if needed
                if (shouldUpdateDb) {
                    updateUserProfile({
                        message_credits_used: 0,
                        credits_reset_date: resetDate,
                    }).catch((error) => {
                        console.error("Failed to auto-reset credits", error);
                    });
                }
            }
        } catch {
            // Calculate a default future reset date for fallback
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);

            // Set fallback profile data on exception
            setProfile({
                displayName: null,
                organisation: null,
                messageCreditsUsed: 0,
                creditsResetDate: futureResetDate.toISOString(),
                creditsRemaining: 999999, // temporarily unlimited
                tier: "Free",
                tabularModel: "casemark/core-large",
                caseApiKey: DEFAULT_CASE_KEY_STATUS,
                caseModels: FALLBACK_CASE_MODELS,
                caseModelCatalog: {
                    source: "fallback",
                    key_source: "missing",
                },
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, user, loadProfile]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) {
                return false;
            }

            try {
                await updateUserProfile({ display_name: displayName });

                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                await updateUserProfile({ organisation });
                setProfile((prev) =>
                    prev ? { ...prev, organisation } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateModelPreference = useCallback(
        async (
            field: "tabularModel",
            value: string,
        ): Promise<boolean> => {
            if (!user) return false;
            if (field !== "tabularModel") return false;
            try {
                await updateUserProfile({ tabular_model: value });
                setProfile((prev) =>
                    prev ? { ...prev, [field]: value } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateCaseApiKey = useCallback(
        async (
            value: string | null,
        ): Promise<{ ok: boolean; error?: string }> => {
            if (!user) return { ok: false, error: "You must be signed in." };
            try {
                const status = await saveCaseApiKey(
                    value?.trim() ? value.trim() : null,
                );
                const catalog = await getCaseModelCatalog().catch(
                    () => DEFAULT_CASE_MODEL_CATALOG,
                );
                setProfile((prev) =>
                    prev
                        ? {
                              ...prev,
                              caseApiKey: status,
                              caseModels: catalog.models.length
                                  ? catalog.models
                                  : FALLBACK_CASE_MODELS,
                              caseModelCatalog: {
                                  source: catalog.source,
                                  key_source: catalog.key_source,
                                  error: catalog.error,
                              },
                          }
                        : null,
                );
                return { ok: true };
            } catch (err) {
                return {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (user) {
            await loadProfile();
        }
    }, [user, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) {
            return false;
        }

        // Check if user has credits remaining
        if (profile.creditsRemaining <= 0) {
            return false;
        }

        try {
            const newCreditsUsed = profile.messageCreditsUsed + 1;

            await updateUserProfile({
                message_credits_used: newCreditsUsed,
            });

            // Update local state
            setProfile((prev) =>
                prev
                    ? {
                          ...prev,
                          messageCreditsUsed: newCreditsUsed,
                          creditsRemaining: 999999 - newCreditsUsed, // temporarily unlimited
                      }
                    : null,
            );

            return true;
        } catch {
            return false;
        }
    }, [user, profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateCaseApiKey,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
