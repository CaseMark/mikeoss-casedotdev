"use client";

import { useCallback, useState } from "react";
import { DEFAULT_MODEL_ID } from "../lib/caseModels";
import { isRecognizedModelId } from "../lib/modelAvailability";

const STORAGE_KEY = "mike.selectedModel";

function readStored(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && isRecognizedModelId(raw)) return raw;
    return DEFAULT_MODEL_ID;
}

export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(() => readStored());

    const setModel = useCallback((id: string) => {
        const next = isRecognizedModelId(id) ? id : DEFAULT_MODEL_ID;
        setModelState(next);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
    }, []);

    return [model, setModel];
}
