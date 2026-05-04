"use client";

import { useState } from "react";
import { AlertCircle, Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import {
    GROUP_ORDER,
    modelOptionsOrFallback,
    type ModelOption,
} from "@/app/lib/caseModels";
import type {
    CaseApiKeyStatus,
    CaseModelCatalog,
    DemoUsageStatus,
} from "@/app/lib/mikeApi";

export default function ModelsAndApiKeysPage() {
    const { profile, updateModelPreference, updateCaseApiKey } =
        useUserProfile();
    const apiKeys = {
        caseApiKeyConfigured: profile?.caseApiKey.configured ?? false,
    };
    const models = modelOptionsOrFallback(profile?.caseModels);
    const keySource = profile?.caseApiKey.source ?? "missing";
    const usingServerKey = keySource === "server";
    const usingDemoKey = keySource === "demo";

    return (
        <div className="space-y-4">
            {/* Model Preferences */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">
                        Model Preferences
                    </h2>
                </div>
                <div className="space-y-4 max-w-md">
                    <div>
                        <label className="text-sm text-gray-600 block mb-2">
                            Tabular review model
                        </label>
                        <TabularModelDropdown
                            value={
                                profile?.tabularModel ??
                                "casemark/core-large"
                            }
                            apiKeys={apiKeys}
                            models={models}
                            onChange={(id) =>
                                updateModelPreference("tabularModel", id)
                            }
                        />
                    </div>
                </div>
            </div>

            {/* API Keys */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-medium font-serif">
                        API Keys
                    </h2>
                </div>
                <p className="text-sm text-gray-500 mb-4 max-w-xl">
                    {usingDemoKey
                        ? "This hosted demo uses a shared Case.dev key with a per-user budget."
                        : "Add your Case.dev API key to use Mike's model gateway, vault indexing, document search, and Case-powered extraction features."}
                </p>
                <p className="text-xs text-gray-400 mb-4 max-w-xl">
                    The key is validated by the backend and stored encrypted.
                    Only the saved key status is shown here.
                </p>
                <CaseStatusSummary
                    status={profile?.caseApiKey}
                    modelCatalog={profile?.caseModelCatalog}
                    modelCount={models.length}
                />
                {usingDemoKey && (
                    <DemoBudgetSummary usage={profile?.demoUsage} />
                )}
                <div className="space-y-4 max-w-xl">
                    {usingDemoKey ? (
                        <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
                            <p className="text-sm font-medium text-gray-900">
                                Demo key active
                            </p>
                            <p className="mt-1 text-xs text-gray-500">
                                Personal Case.dev keys are disabled in this hosted demo. Forked and local installs can still use their own key when Demo Mode is off.
                            </p>
                        </div>
                    ) : (
                        <ApiKeyField
                            label="Case.dev API Key"
                            placeholder={
                                profile?.caseApiKey.source === "user" &&
                                profile.caseApiKey.last4
                                    ? `Saved key ending in ${profile.caseApiKey.last4}`
                                    : usingServerKey && profile?.caseApiKey.last4
                                      ? `Using local server key ending in ${profile.caseApiKey.last4}`
                                    : "sk_case_..."
                            }
                            status={
                                profile?.caseApiKey.source === "user" &&
                                profile.caseApiKey.configured
                                    ? `Verified key ending in ${profile.caseApiKey.last4 ?? "****"}`
                                    : usingServerKey
                                      ? "Using local server key for development"
                                    : undefined
                            }
                            error={profile?.caseApiKey.error ?? undefined}
                            onSave={(value) =>
                                updateCaseApiKey(value.trim() || null)
                            }
                            canClear={profile?.caseApiKey.source === "user"}
                            onClear={() => updateCaseApiKey(null)}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

function CaseStatusSummary({
    status,
    modelCatalog,
    modelCount,
}: {
    status?: CaseApiKeyStatus;
    modelCatalog?: Omit<CaseModelCatalog, "models">;
    modelCount: number;
}) {
    const configured = status?.configured ?? false;
    const source = status?.source ?? "missing";
    const sourceLabel =
        source === "user"
            ? "Personal key"
            : source === "server"
              ? "Local server key"
              : source === "demo"
                ? "Demo key"
              : "No key";
    const verifiedAt = status?.verified_at
        ? new Date(status.verified_at).toLocaleString()
        : null;

    return (
        <div className="mb-5 max-w-xl rounded-md border border-gray-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-sm font-medium text-gray-900">
                        {sourceLabel}
                    </p>
                    <p className="text-xs text-gray-500">
                        {configured
                            ? verifiedAt
                                ? `Verified ${verifiedAt}`
                                : "Verified"
                            : source === "demo"
                              ? "The shared demo key is not ready."
                            : "Add a Case.dev key to enable model routing and vault search."}
                    </p>
                </div>
                <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                        configured
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-gray-100 text-gray-500"
                    }`}
                >
                    {configured ? "Ready" : "Missing"}
                </span>
            </div>
            <div className="mt-3 grid grid-cols-5 gap-2 text-xs text-gray-600">
                <StatusPill
                    label="LLM"
                    ok={status?.capabilities.llm ?? false}
                />
                <StatusPill
                    label="Vault"
                    ok={status?.capabilities.vault ?? false}
                />
                <StatusPill
                    label="Skills"
                    ok={status?.capabilities.skills ?? false}
                />
                <StatusPill
                    label="Legal"
                    ok={status?.capabilities.legal ?? false}
                />
                <StatusPill
                    label="Models"
                    value={`${status?.capabilities.model_count ?? modelCount}`}
                    ok={modelCount > 0}
                />
            </div>
            <p className="mt-3 text-xs text-gray-400">
                Model catalog: {modelCatalog?.source ?? "fallback"}
                {modelCatalog?.key_source
                    ? ` via ${modelCatalog.key_source} key`
                    : ""}
                {modelCatalog?.error ? ` (${modelCatalog.error})` : ""}
            </p>
        </div>
    );
}

function DemoBudgetSummary({ usage }: { usage?: DemoUsageStatus }) {
    if (!usage?.enabled) return null;
    const limit = formatUsd(usage.limit_usd);
    const spent = formatUsd(usage.spent_usd);
    const reserved = usage.reserved_usd > 0 ? formatUsd(usage.reserved_usd) : null;
    const remaining = formatUsd(usage.remaining_usd);
    const pct =
        usage.limit_usd > 0
            ? Math.min(100, Math.max(0, ((usage.spent_usd + usage.reserved_usd) / usage.limit_usd) * 100))
            : 0;

    return (
        <div className="mb-5 max-w-xl rounded-md border border-gray-200 bg-white px-4 py-3">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-sm font-medium text-gray-900">
                        Demo budget
                    </p>
                    <p className="text-xs text-gray-500">
                        {usage.blocked
                            ? "Budget exhausted for this account."
                            : `${remaining} remaining of ${limit}`}
                    </p>
                </div>
                <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                        usage.blocked
                            ? "bg-red-50 text-red-700"
                            : "bg-emerald-50 text-emerald-700"
                    }`}
                >
                    {usage.blocked ? "Exhausted" : "Active"}
                </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                <div
                    className={`h-full ${usage.blocked ? "bg-red-500" : "bg-gray-900"}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <p className="mt-2 text-xs text-gray-400">
                Spent {spent}
                {reserved ? `, ${reserved} reserved` : ""}.
            </p>
        </div>
    );
}

function formatUsd(value: number) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}

function StatusPill({
    label,
    ok,
    value,
}: {
    label: string;
    ok: boolean;
    value?: string;
}) {
    return (
        <div className="rounded-md border border-gray-200 px-2 py-1">
            <span className={ok ? "text-emerald-700" : "text-gray-400"}>
                {label}: {value ?? (ok ? "ready" : "missing")}
            </span>
        </div>
    );
}

function TabularModelDropdown({
    value,
    onChange,
    apiKeys,
    models,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys: { caseApiKeyConfigured: boolean };
    models: ModelOption[];
}) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = models.find((m) => m.id === value);
    const selectedAvailable = isModelAvailable(value, apiKeys, models);

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/10"
                >
                    <span className="flex items-center gap-2 min-w-0">
                        {!selectedAvailable && (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        )}
                        <span className="truncate text-gray-900">
                            {selected?.label ?? "Select a model"}
                        </span>
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {GROUP_ORDER.map((group, gi) => {
                    const items = models.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const available = isModelAvailable(
                                    m.id,
                                    apiKeys,
                                    models,
                                );
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                        title={
                                            !available
                                                ? "Add a Case.dev API key to use this model"
                                                : undefined
                                        }
                                    >
                                        <span
                                            className={`flex-1 ${available ? "" : "text-gray-400"}`}
                                        >
                                            {m.label}
                                            {m.source === "live" && (
                                                <span className="ml-1 text-[10px] text-gray-400">
                                                    live
                                                </span>
                                            )}
                                        </span>
                                        {!available && (
                                            <AlertCircle className="h-3.5 w-3.5 text-red-500 ml-1" />
                                        )}
                                        {m.id === value && available && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                        )}
                                    </DropdownMenuItem>
                                );
                            })}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function ApiKeyField({
    label,
    placeholder,
    status,
    error,
    onSave,
    canClear,
    onClear,
}: {
    label: string;
    placeholder: string;
    status?: string;
    error?: string;
    onSave: (value: string) => Promise<{ ok: boolean; error?: string }>;
    canClear?: boolean;
    onClear: () => Promise<{ ok: boolean; error?: string }>;
}) {
    const [value, setValue] = useState("");
    const [reveal, setReveal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [localError, setLocalError] = useState<string | null>(null);

    const hasValue = !!value.trim();

    const handleSave = async () => {
        if (!hasValue) return;
        setIsSaving(true);
        setLocalError(null);
        const result = await onSave(value);
        setIsSaving(false);
        if (result.ok) {
            setValue("");
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            setLocalError(result.error ?? `Failed to save ${label}.`);
        }
    };

    const handleClear = async () => {
        setIsSaving(true);
        setLocalError(null);
        const result = await onClear();
        setIsSaving(false);
        if (result.ok) {
            setValue("");
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            setLocalError(result.error ?? `Failed to clear ${label}.`);
        }
    };

    return (
        <div>
            <label className="text-sm text-gray-600 block mb-2">{label}</label>
            {status && (
                <p className="text-xs text-gray-500 mb-2">{status}</p>
            )}
            {error && (
                <p className="text-xs text-red-500 mb-2">{error}</p>
            )}
            {localError && (
                <p className="text-xs text-red-500 mb-2">{localError}</p>
            )}
            <div className="flex gap-2">
                <div className="relative flex-1">
                    <Input
                        type={reveal ? "text" : "password"}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={placeholder}
                        className="pr-10"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <button
                        type="button"
                        onClick={() => setReveal((r) => !r)}
                        className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600"
                        aria-label={reveal ? "Hide key" : "Show key"}
                    >
                        {reveal ? (
                            <EyeOff className="h-4 w-4" />
                        ) : (
                            <Eye className="h-4 w-4" />
                        )}
                    </button>
                </div>
                <Button
                    onClick={handleSave}
                    disabled={isSaving || !hasValue || saved}
                    className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                >
                    {isSaving ? (
                        "Saving..."
                    ) : saved ? (
                        <>
                            <Check className="h-4 w-3" />
                            Saved
                        </>
                    ) : (
                        "Save"
                    )}
                </Button>
                {canClear && (
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleClear}
                        disabled={isSaving || saved}
                    >
                        Clear
                    </Button>
                )}
            </div>
        </div>
    );
}
