"use client";

import { useEffect, useRef, useState } from "react";

/**
 * /display returns either PDF bytes (when the active version has a PDF
 * rendition) or raw DOCX bytes otherwise. Reporting the type lets the
 * caller swap between DocView (PDF.js) and DocxView (docx-preview)
 * accordingly.
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "docx" }
    | null;

async function documentLoadError(response: Response): Promise<Error> {
    let message = `HTTP ${response.status}`;
    try {
        const body = (await response.json()) as {
            code?: string;
            detail?: string;
            error?: string;
        };
        if (body.code === "demo_budget_exceeded") {
            message =
                "This account has reached its demo credit limit. Add your own Case.dev key in Account > Models or ask the demo operator to reset your budget.";
        } else {
            message = body.detail ?? body.error ?? message;
        }
    } catch {
        /* keep HTTP fallback */
    }
    return new Error(message);
}

export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
) {
    const [result, setResult] = useState<DocResult>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const prevKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!documentId) return;
        const requestKey = `${documentId}:${versionId ?? "current"}`;
        if (requestKey === prevKeyRef.current) return;
        prevKeyRef.current = requestKey;

        setLoading(true);
        setError(null);
        setResult(null);

        let cancelled = false;

        (async () => {
            try {
                if (cancelled) return;

                const apiBase =
                    process.env.NEXT_PUBLIC_API_BASE_URL ??
                    "http://localhost:3001";
                const qs = versionId
                    ? `?version_id=${encodeURIComponent(versionId)}`
                    : "";
                const response = await fetch(
                    `${apiBase}/single-documents/${documentId}/display${qs}`,
                    {
                        credentials: "include",
                    },
                );
                if (!response.ok) throw await documentLoadError(response);
                if (cancelled) return;

                const contentType =
                    response.headers.get("content-type") ?? "";
                if (contentType.includes("application/pdf")) {
                    const buffer = await response.arrayBuffer();
                    if (!cancelled) setResult({ type: "pdf", buffer });
                } else {
                    // Drain the body so the connection is reusable, but the
                    // bytes are useless to the PDF viewer — the caller will
                    // fall back to DocxView, which fetches `/docx` itself.
                    await response.arrayBuffer().catch(() => {});
                    if (!cancelled) setResult({ type: "docx" });
                }
            } catch (err) {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Failed to load document.",
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            prevKeyRef.current = null;
        };
    }, [documentId, versionId]);

    return { result, loading, error };
}
