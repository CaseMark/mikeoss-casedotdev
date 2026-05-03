"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    Check,
    ExternalLink,
    Loader2,
    Search,
    Sparkles,
    X,
} from "lucide-react";
import {
    getCaseSkill,
    listCustomCaseSkills,
    searchCaseSkills,
    type CaseSkillDetail,
    type CaseSkillSummary,
} from "@/app/lib/mikeApi";
import type { MikeWorkflow } from "../shared/types";
import { useRouter } from "next/navigation";

const MIN_SEARCH_LENGTH = 2;
const SEARCH_LIMIT = 16;

type SourceFilter = "all" | "case" | "custom";

export interface CaseSkillSelection {
    skill: CaseSkillSummary;
    detail: CaseSkillDetail | null;
}

interface CaseSkillsCatalogProps {
    importedWorkflows?: MikeWorkflow[];
    mode?: "catalog" | "picker";
    selectedSlug?: string | null;
    onSelectedSkillChange?: (selection: CaseSkillSelection | null) => void;
    onCreateWorkflow?: (skill: CaseSkillSummary) => Promise<void> | void;
    onOpenWorkflow?: (workflow: MikeWorkflow) => void;
    className?: string;
}

interface CaseSkillPreviewModalProps {
    workflow: MikeWorkflow;
    onClose: () => void;
}

function normalizeSource(source: string | null | undefined): CaseSkillSummary["source"] {
    if (source === "custom" || source === "curated") return source;
    return null;
}

function workflowToSkillSummary(workflow: MikeWorkflow): CaseSkillSummary | null {
    if (!workflow.case_skill_slug) return null;
    return {
        slug: workflow.case_skill_slug,
        name: workflow.case_skill_name ?? workflow.title,
        summary: workflow.case_skill_summary ?? null,
        tags: workflow.case_skill_tags ?? [],
        score: null,
        source: normalizeSource(workflow.case_skill_source),
        version: workflow.case_skill_version ?? null,
        author_name: null,
        license: null,
    };
}

function mergeSkills(...lists: CaseSkillSummary[][]) {
    const bySlug = new Map<string, CaseSkillSummary>();
    for (const list of lists) {
        for (const skill of list) {
            const existing = bySlug.get(skill.slug);
            bySlug.set(skill.slug, {
                ...skill,
                ...existing,
                summary: existing?.summary ?? skill.summary,
                tags: existing?.tags?.length ? existing.tags : skill.tags,
                source: existing?.source ?? skill.source,
                version: existing?.version ?? skill.version,
            });
        }
    }
    return Array.from(bySlug.values());
}

function sourceLabel(skill: CaseSkillSummary) {
    return skill.source === "custom" ? "Custom" : "Case";
}

function isKeyError(message: string) {
    const lower = message.toLowerCase();
    return lower.includes("api key") || lower.includes("skills access");
}

function filteredByQuery(skill: CaseSkillSummary, query: string) {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
        skill.name.toLowerCase().includes(q) ||
        skill.slug.toLowerCase().includes(q) ||
        (skill.summary ?? "").toLowerCase().includes(q) ||
        skill.tags.some((tag) => tag.toLowerCase().includes(q))
    );
}

function filterBySource(skill: CaseSkillSummary, sourceFilter: SourceFilter) {
    if (sourceFilter === "all") return true;
    if (sourceFilter === "custom") return skill.source === "custom";
    return skill.source !== "custom";
}

function SkillTags({ tags, limit = 5 }: { tags: string[]; limit?: number }) {
    if (tags.length === 0) return null;
    return (
        <div className="mt-1.5 flex flex-wrap gap-1">
            {tags.slice(0, limit).map((tag) => (
                <span
                    key={tag}
                    className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                >
                    {tag}
                </span>
            ))}
        </div>
    );
}

function AccessCallout({ message }: { message: string }) {
    const router = useRouter();
    return (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="min-w-0 text-xs text-amber-800">{message}</p>
            <button
                type="button"
                onClick={() => router.push("/account/models")}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100"
            >
                Models
                <ExternalLink className="h-3 w-3" />
            </button>
        </div>
    );
}

function SkillPreviewPanel({
    skill,
    detail,
    importedWorkflow,
    detailLoading,
    error,
    mode,
    creating,
    onCreateWorkflow,
    onOpenWorkflow,
}: {
    skill: CaseSkillSummary | null;
    detail: CaseSkillDetail | null;
    importedWorkflow?: MikeWorkflow;
    detailLoading?: boolean;
    error?: string;
    mode: "catalog" | "picker";
    creating?: boolean;
    onCreateWorkflow?: (skill: CaseSkillSummary) => Promise<void> | void;
    onOpenWorkflow?: (workflow: MikeWorkflow) => void;
}) {
    if (!skill) {
        return (
            <div className="flex min-h-[220px] flex-col items-start justify-center rounded-md border border-gray-200 bg-gray-50 p-5">
                <Sparkles className="h-6 w-6 text-gray-300" />
                <p className="mt-3 text-sm font-medium text-gray-700">
                    Select a skill
                </p>
                <p className="mt-1 text-xs leading-relaxed text-gray-400">
                    Search the Case.dev catalog, then preview instructions before
                    adding a skill as a Mike workflow.
                </p>
            </div>
        );
    }

    const content = detail?.content ?? importedWorkflow?.case_skill_content_snapshot ?? "";

    return (
        <div className="flex min-h-0 flex-1 flex-col rounded-md border border-gray-200 bg-white">
            <div className="shrink-0 border-b border-gray-100 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                            <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                            <p className="truncate text-sm font-medium text-gray-900">
                                {skill.name}
                            </p>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                            <span>{sourceLabel(skill)}</span>
                            {skill.version && <span>v{skill.version}</span>}
                            {importedWorkflow && (
                                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
                                    Added
                                </span>
                            )}
                        </div>
                    </div>
                    {mode === "picker" && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                            <Check className="h-3 w-3" />
                            Selected
                        </span>
                    )}
                </div>
                {skill.summary && (
                    <p className="mt-2 text-xs leading-relaxed text-gray-500">
                        {skill.summary}
                    </p>
                )}
                <SkillTags tags={skill.tags} limit={8} />
                {error && (
                    isKeyError(error) ? (
                        <div className="mt-3">
                            <AccessCallout message={error} />
                        </div>
                    ) : (
                        <p className="mt-2 text-xs text-red-500">{error}</p>
                    )
                )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 p-3">
                {detailLoading && !content ? (
                    <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-gray-400">
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Loading skill
                    </div>
                ) : content ? (
                    <pre className="whitespace-pre-wrap rounded border border-gray-100 bg-white p-3 text-xs leading-relaxed text-gray-600">
                        {content}
                    </pre>
                ) : (
                    <p className="rounded border border-gray-100 bg-white p-4 text-xs text-gray-400">
                        No skill instructions were returned.
                    </p>
                )}
            </div>

            {mode === "catalog" && (
                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-gray-100 px-4 py-3">
                    {importedWorkflow ? (
                        <button
                            type="button"
                            onClick={() => onOpenWorkflow?.(importedWorkflow)}
                            className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
                        >
                            Open workflow
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => onCreateWorkflow?.(skill)}
                            disabled={!onCreateWorkflow || creating}
                            className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                        >
                            {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {creating ? "Adding" : "Add as workflow"}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export function CaseSkillsCatalog({
    importedWorkflows = [],
    mode = "catalog",
    selectedSlug,
    onSelectedSkillChange,
    onCreateWorkflow,
    onOpenWorkflow,
    className = "",
}: CaseSkillsCatalogProps) {
    const [query, setQuery] = useState("");
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
    const [customSkills, setCustomSkills] = useState<CaseSkillSummary[]>([]);
    const [searchResults, setSearchResults] = useState<CaseSkillSummary[]>([]);
    const [selectedSkill, setSelectedSkill] = useState<CaseSkillSummary | null>(null);
    const [selectedDetail, setSelectedDetail] = useState<CaseSkillDetail | null>(null);
    const [customLoading, setCustomLoading] = useState(false);
    const [searchLoading, setSearchLoading] = useState(false);
    const [detailLoading, setDetailLoading] = useState(false);
    const [error, setError] = useState("");
    const [detailError, setDetailError] = useState("");
    const [creatingSlug, setCreatingSlug] = useState<string | null>(null);

    const importedBySlug = useMemo(() => {
        const map = new Map<string, MikeWorkflow>();
        for (const workflow of importedWorkflows) {
            if (workflow.case_skill_slug && !map.has(workflow.case_skill_slug)) {
                map.set(workflow.case_skill_slug, workflow);
            }
        }
        return map;
    }, [importedWorkflows]);

    const importedSkills = useMemo(
        () =>
            importedWorkflows
                .map(workflowToSkillSummary)
                .filter((skill): skill is CaseSkillSummary => !!skill),
        [importedWorkflows],
    );

    useEffect(() => {
        setCustomLoading(true);
        listCustomCaseSkills({ limit: 50 })
            .then((response) => {
                setCustomSkills(response.skills);
                setError("");
            })
            .catch((err: unknown) => {
                setCustomSkills([]);
                setError((err as Error).message || "Failed to load Case.dev skills");
            })
            .finally(() => setCustomLoading(false));
    }, []);

    useEffect(() => {
        const q = query.trim();
        if (q.length < MIN_SEARCH_LENGTH) {
            setSearchResults([]);
            setSearchLoading(false);
            return;
        }

        setSearchLoading(true);
        const timer = window.setTimeout(() => {
            searchCaseSkills(q, SEARCH_LIMIT)
                .then((response) => {
                    setSearchResults(response.results);
                    setError("");
                })
                .catch((err: unknown) => {
                    setSearchResults([]);
                    setError((err as Error).message || "Failed to search Case.dev skills");
                })
                .finally(() => setSearchLoading(false));
        }, 250);

        return () => window.clearTimeout(timer);
    }, [query]);

    useEffect(() => {
        if (!selectedSlug || selectedSkill?.slug === selectedSlug) return;
        const match = mergeSkills(searchResults, customSkills, importedSkills).find(
            (skill) => skill.slug === selectedSlug,
        );
        if (match) void selectSkill(match);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedSlug, searchResults, customSkills, importedSkills]);

    const q = query.trim();
    const displaySkills = useMemo(() => {
        const base =
            q.length >= MIN_SEARCH_LENGTH
                ? mergeSkills(searchResults, customSkills.filter((skill) => filteredByQuery(skill, q)), importedSkills.filter((skill) => filteredByQuery(skill, q)))
                : mergeSkills(customSkills, importedSkills);
        return base.filter((skill) => filterBySource(skill, sourceFilter));
    }, [customSkills, importedSkills, q, searchResults, sourceFilter]);

    const selectedImportedWorkflow = selectedSkill
        ? importedBySlug.get(selectedSkill.slug)
        : undefined;
    const listLoading = customLoading || searchLoading;
    const showSearchHint = q.length > 0 && q.length < MIN_SEARCH_LENGTH;

    async function selectSkill(skill: CaseSkillSummary) {
        setSelectedSkill(skill);
        setSelectedDetail(null);
        setDetailError("");
        const imported = importedBySlug.get(skill.slug);
        if (imported?.case_skill_content_snapshot) {
            setSelectedDetail({
                ...skill,
                content: imported.case_skill_content_snapshot,
                metadata: null,
                bundle: null,
            });
        }
        onSelectedSkillChange?.({ skill, detail: null });
        setDetailLoading(true);
        try {
            const response = await getCaseSkill(skill.slug);
            setSelectedSkill(response.skill);
            setSelectedDetail(response.skill);
            onSelectedSkillChange?.({ skill: response.skill, detail: response.skill });
        } catch (err: unknown) {
            setDetailError((err as Error).message || "Failed to load Case.dev skill");
            onSelectedSkillChange?.({ skill, detail: null });
        } finally {
            setDetailLoading(false);
        }
    }

    async function handleCreateWorkflow(skill: CaseSkillSummary) {
        if (!onCreateWorkflow) return;
        setCreatingSlug(skill.slug);
        setDetailError("");
        try {
            await onCreateWorkflow(skill);
        } catch (err: unknown) {
            setDetailError((err as Error).message || "Failed to add skill as workflow");
        } finally {
            setCreatingSlug(null);
        }
    }

    const sourceButtons: { id: SourceFilter; label: string }[] = [
        { id: "all", label: "All" },
        { id: "case", label: "Case" },
        { id: "custom", label: "Custom" },
    ];

    return (
        <div
            className={`flex min-h-0 flex-col ${
                mode === "catalog" ? "h-full" : ""
            } ${className}`}
        >
            <div className="shrink-0 space-y-2 border-b border-gray-100 bg-white p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5">
                        <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search Case.dev skills…"
                            className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 placeholder:text-gray-400 outline-none"
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => setQuery("")}
                                className="text-gray-400 hover:text-gray-600"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-white p-0.5">
                        {sourceButtons.map((button) => (
                            <button
                                key={button.id}
                                type="button"
                                onClick={() => setSourceFilter(button.id)}
                                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                                    sourceFilter === button.id
                                        ? "bg-gray-900 text-white"
                                        : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                                }`}
                            >
                                {button.label}
                            </button>
                        ))}
                    </div>
                </div>
                {showSearchHint && (
                    <p className="text-xs text-gray-400">
                        Type at least {MIN_SEARCH_LENGTH} characters to search the Case catalog.
                    </p>
                )}
                {error &&
                    (isKeyError(error) ? (
                        <AccessCallout message={error} />
                    ) : (
                        <p className="text-xs text-red-500">{error}</p>
                    ))}
            </div>

            <div
                className={`grid min-h-0 flex-1 gap-3 p-3 ${
                    mode === "catalog"
                        ? "lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]"
                        : "grid-cols-1"
                }`}
            >
                <div className="min-h-0 overflow-hidden rounded-md border border-gray-200 bg-white">
                    <div
                        className={`overflow-y-auto ${
                            mode === "catalog" ? "h-full" : "max-h-52"
                        }`}
                    >
                        {listLoading && displaySkills.length === 0 ? (
                            <div className="space-y-2 p-3">
                                {[1, 2, 3].map((item) => (
                                    <div key={item} className="space-y-1.5 rounded-md border border-gray-100 p-3">
                                        <div className="h-3 w-32 rounded bg-gray-100 animate-pulse" />
                                        <div className="h-2.5 w-full rounded bg-gray-100 animate-pulse" />
                                        <div className="h-2.5 w-2/3 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                ))}
                            </div>
                        ) : displaySkills.length === 0 ? (
                            <div className="flex min-h-[160px] flex-col items-start justify-center p-5">
                                <Sparkles className="h-6 w-6 text-gray-300" />
                                <p className="mt-3 text-sm font-medium text-gray-700">
                                    No skills found
                                </p>
                                <p className="mt-1 text-xs leading-relaxed text-gray-400">
                                    Search by practice area, task, or workflow goal.
                                    Custom skills and imported skills appear here when no search is active.
                                </p>
                            </div>
                        ) : (
                            displaySkills.map((skill) => {
                                const imported = importedBySlug.get(skill.slug);
                                const selected = selectedSkill?.slug === skill.slug;
                                return (
                                    <button
                                        key={skill.slug}
                                        type="button"
                                        onClick={() => selectSkill(skill)}
                                        className={`w-full border-b border-gray-100 px-3 py-3 text-left transition-colors last:border-b-0 ${
                                            selected ? "bg-gray-50" : "hover:bg-gray-50"
                                        }`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="truncate text-sm font-medium text-gray-800">
                                                        {skill.name}
                                                    </span>
                                                    {imported && (
                                                        <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                                            Added
                                                        </span>
                                                    )}
                                                </div>
                                                {skill.summary && (
                                                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-500">
                                                        {skill.summary}
                                                    </p>
                                                )}
                                            </div>
                                            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                                                {sourceLabel(skill)}
                                            </span>
                                        </div>
                                        <SkillTags tags={skill.tags} />
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>

                <SkillPreviewPanel
                    skill={selectedSkill}
                    detail={selectedDetail}
                    importedWorkflow={selectedImportedWorkflow}
                    detailLoading={detailLoading}
                    error={detailError}
                    mode={mode}
                    creating={creatingSlug === selectedSkill?.slug}
                    onCreateWorkflow={handleCreateWorkflow}
                    onOpenWorkflow={onOpenWorkflow}
                />
            </div>
        </div>
    );
}

export function CaseSkillPreviewModal({ workflow, onClose }: CaseSkillPreviewModalProps) {
    const [skill, setSkill] = useState<CaseSkillSummary | null>(() =>
        workflowToSkillSummary(workflow),
    );
    const [detail, setDetail] = useState<CaseSkillDetail | null>(() => {
        const summary = workflowToSkillSummary(workflow);
        if (!summary || !workflow.case_skill_content_snapshot) return null;
        return {
            ...summary,
            content: workflow.case_skill_content_snapshot,
            metadata: null,
            bundle: null,
        };
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!workflow.case_skill_slug) return;
        let cancelled = false;
        Promise.resolve()
            .then(() => {
                if (!cancelled) setLoading(true);
                return getCaseSkill(workflow.case_skill_slug!);
            })
            .then((response) => {
                if (cancelled) return;
                setSkill(response.skill);
                setDetail(response.skill);
                setError("");
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError((err as Error).message || "Failed to load Case.dev skill");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [workflow.case_skill_slug]);

    return createPortal(
        <div className="fixed inset-0 z-[102] flex items-center justify-center bg-black/20 px-4 backdrop-blur-xs">
            <div className="flex h-[640px] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex shrink-0 items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span>Workflows</span>
                        <span>›</span>
                        <span>Case skill</span>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="min-h-0 flex-1 p-4 pt-0">
                    <SkillPreviewPanel
                        skill={skill}
                        detail={detail}
                        importedWorkflow={workflow}
                        detailLoading={loading}
                        error={error}
                        mode="picker"
                    />
                </div>
            </div>
        </div>,
        document.body,
    );
}
