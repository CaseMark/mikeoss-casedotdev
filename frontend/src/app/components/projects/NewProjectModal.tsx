"use client";

import { useRef, useState } from "react";
import { X, Users, Upload } from "lucide-react";
import {
    addDocumentToProject,
    createProject,
    uploadProjectDocument,
} from "@/app/lib/mikeApi";
import { useDirectoryData } from "../shared/useDirectoryData";
import { FileDirectory } from "../shared/FileDirectory";
import { EmailPillInput } from "../shared/EmailPillInput";
import type { MikeProject } from "../shared/types";

interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (project: MikeProject) => void;
}

export function NewProjectModal({ open, onClose, onCreated }: Props) {
    const [name, setName] = useState("");
    const [cmNumber, setCmNumber] = useState("");
    const [clientName, setClientName] = useState("");
    const [practiceArea, setPracticeArea] = useState("");
    const [matterType, setMatterType] = useState("");
    const [sharedEmails, setSharedEmails] = useState<string[]>([]);
    const [showMembers, setShowMembers] = useState(false);
    const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const { loading: dirLoading, standaloneDocuments, projects: dirProjects } = useDirectoryData(open);

    if (!open) return null;

    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (!files.length) return;
        setPendingFiles((prev) => [...prev, ...files.filter((f) => !prev.some((p) => p.name === f.name))]);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim()) return;
        setLoading(true);
        setError("");
        try {
            const project = await createProject(
                name.trim(),
                cmNumber.trim() || undefined,
                sharedEmails,
                {
                    client_name: clientName.trim() || null,
                    practice_area: practiceArea.trim() || null,
                    matter_type: matterType.trim() || null,
                },
            );
            await Promise.all([
                ...[...selectedDocIds].map((id) => addDocumentToProject(project.id, id).catch(() => {})),
                ...pendingFiles.map((f) => uploadProjectDocument(project.id, f).catch(() => {})),
            ]);
            onCreated({ ...project, document_count: selectedDocIds.size + pendingFiles.length });
            resetForm();
            onClose();
        } catch (err: unknown) {
            const message = (err as Error).message || "Failed to create matter";
            setError(
                message.includes("case_matter_id")
                    ? "Your local database schema is missing the Case Matter columns. Run the latest backend migration, then try again."
                    : message,
            );
        } finally {
            setLoading(false);
        }
    }

    function resetForm() {
        setName("");
        setCmNumber("");
        setClientName("");
        setPracticeArea("");
        setMatterType("");
        setSharedEmails([]);
        setShowMembers(false);
        setSelectedDocIds(new Set());
        setPendingFiles([]);
        setError("");
    }

    function handleClose() {
        resetForm();
        onClose();
    }

    return (
        <div className="fixed inset-0 z-101 flex items-center justify-center bg-black/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-6 pt-5 pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span>Matters</span>
                        <span>›</span>
                        <span>New matter</span>
                    </div>
                    <button
                        onClick={handleClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
                    <div className="px-6 pt-3 pb-5 flex-1 overflow-y-auto">
                        {/* Title */}
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Matter name"
                            className="w-full text-2xl font-serif text-gray-800 placeholder-gray-300 focus:outline-none bg-transparent"
                            autoFocus
                        />

                        {/* CM Number */}
                        <input
                            type="text"
                            value={cmNumber}
                            onChange={(e) => setCmNumber(e.target.value)}
                            placeholder="Add a CM number..."
                            className="mt-1.5 w-full text-sm text-gray-500 placeholder-gray-300 focus:outline-none bg-transparent"
                        />

                        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <input
                                type="text"
                                value={clientName}
                                onChange={(e) => setClientName(e.target.value)}
                                placeholder="Client"
                                className="rounded border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-300 outline-none focus:border-gray-400"
                            />
                            <input
                                type="text"
                                value={practiceArea}
                                onChange={(e) => setPracticeArea(e.target.value)}
                                placeholder="Practice area"
                                className="rounded border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-300 outline-none focus:border-gray-400"
                            />
                            <input
                                type="text"
                                value={matterType}
                                onChange={(e) => setMatterType(e.target.value)}
                                placeholder="Matter type"
                                className="rounded border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-300 outline-none focus:border-gray-400"
                            />
                        </div>

                        {/* Attribute pills */}
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setShowMembers((v) => !v)}
                                className="flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                            >
                                <Users className="h-3 w-3 text-gray-400" />
                                Members{sharedEmails.length > 0 ? ` (${sharedEmails.length})` : ""}
                            </button>
                        </div>

                        {/* Members panel */}
                        {showMembers && (
                            <div className="mt-3">
                                <EmailPillInput
                                    emails={sharedEmails}
                                    onChange={setSharedEmails}
                                    placeholder="Add colleagues by email…"
                                />
                            </div>
                        )}

                        {/* Documents */}
                        <div className="mt-4 space-y-2">
                            <p className="text-xs font-medium text-gray-700">Select documents</p>
                                <FileDirectory
                                    standaloneDocs={standaloneDocuments}
                                    directoryProjects={dirProjects}
                                    loading={dirLoading}
                                    selectedIds={selectedDocIds}
                                    onChange={setSelectedDocIds}
                                    emptyMessage="No existing documents"
                                />

                        </div>

                    </div>

                    {/* Footer */}
                    <div className="flex items-end justify-between gap-4 border-t border-gray-100 px-6 py-4 shrink-0">
                        <div className="min-w-0 flex-1">
                            {error && (
                                <p
                                    role="alert"
                                    className="mb-2 max-h-12 overflow-y-auto text-xs leading-snug text-red-500"
                                >
                                    {error}
                                </p>
                            )}
                            <div className="flex items-center gap-2">
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    multiple
                                    className="hidden"
                                    onChange={handleFileChange}
                                />
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
                                >
                                    <Upload className="h-3.5 w-3.5" />
                                    Upload files{pendingFiles.length > 0 ? ` (${pendingFiles.length})` : ""}
                                </button>
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="rounded-lg px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={!name.trim() || loading}
                                className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
                            >
                                {loading ? "Creating…" : "Create matter"}
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
