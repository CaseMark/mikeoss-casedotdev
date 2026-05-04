"use client";

import { useCallback, useState } from "react";
import { DEFAULT_MODEL_ID, FALLBACK_CASE_MODELS } from "../lib/caseModels";

const STORAGE_KEY = "mike.selectedModel";

function readStored(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && isAllowedCaseModelId(raw)) return raw;
    return DEFAULT_MODEL_ID;
}

function isAllowedCaseModelId(id: string): boolean {
    return (
        FALLBACK_CASE_MODELS.some((model) => model.id === id) ||
        id.includes("/") ||
        id.startsWith("claude") ||
        id.startsWith("gemini")
    );
}

export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(() => readStored());

    const setModel = useCallback((id: string) => {
        const next = isAllowedCaseModelId(id) ? id : DEFAULT_MODEL_ID;
        setModelState(next);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
    }, []);

    return [model, setModel];
}
