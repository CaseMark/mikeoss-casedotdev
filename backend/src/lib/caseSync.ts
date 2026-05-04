import type { createServerDb } from "./db";
import {
    CaseApiError,
    CaseClient,
    type CaseVaultChunk,
    type CaseVaultSearchMethod,
} from "./caseClient";
import {
    caseClientForEffectiveKey,
    getEffectiveCaseApiKey,
    type EffectiveCaseApiKey,
} from "./caseCredentials";
import {
    ensureCaseVaultLink,
    hashBytes,
    parseCaseStorageUri,
    type CaseBlobRole,
} from "./storage";

type Db = ReturnType<typeof createServerDb>;

type DocumentLink = {
    document_id: string;
    version_id: string;
    role: CaseBlobRole;
    vault_link_id: string | null;
    case_vault_id: string | null;
    case_object_id: string | null;
    sync_status: string;
    ingestion_status: string | null;
    filename: string | null;
    text_length: number | null;
    chunk_count: number | null;
    vector_count?: number | null;
    graph_status?: string | null;
    transcript_object_id?: string | null;
    object_metadata?: Record<string, unknown> | null;
    last_seen_at?: string | null;
};

export type CaseDocumentSearchHit = {
    document_id: string;
    version_id: string;
    case_vault_id: string;
    case_object_id: string;
    filename: string | null;
    chunk_index: number | null;
    page_start: number | null;
    page_end: number | null;
    score: number | null;
    preview_text: string;
    text: string;
    surrounding_chunks: {
        index: number | null;
        page_start: number | null;
        page_end: number | null;
        text: string;
    }[];
};

export type CaseDocumentSearchResponse = {
    hits: CaseDocumentSearchHit[];
    searched_object_count: number;
    method?: CaseVaultSearchMethod;
    response?: string | null;
    sources?: unknown[];
    skipped_reason?: string;
};

export type CaseVaultDocumentInfo = {
    doc_id?: string | null;
    document_id: string;
    version_id: string;
    filename: string | null;
    case_vault_id: string | null;
    case_object_id: string | null;
    sync_status: string;
    ingestion_status: string | null;
    searchable: boolean;
    page_count: number | null;
    text_length: number | null;
    chunk_count: number | null;
    vector_count: number | null;
    graph_status: string | null;
    transcript_object_id: string | null;
    error?: string | null;
    last_synced_at?: string | null;
    last_seen_at?: string | null;
};

export type CaseDocumentContextResponse = {
    ok: boolean;
    document_id?: string;
    version_id?: string;
    filename?: string | null;
    case_vault_id?: string;
    case_object_id?: string;
    chunk_index?: number;
    total_chunks?: number;
    chunks?: {
        index: number | null;
        page_start: number | null;
        page_end: number | null;
        word_start_index: number | null;
        word_end_index: number | null;
        text: string;
    }[];
    ocr_words?: {
        available: boolean;
        total_words?: number | null;
        note?: string;
    };
    error?: string;
};

function contentTypeForFilename(filename: string, fallback?: string | null) {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext === "pdf") return "application/pdf";
    if (ext === "doc" || ext === "docx") {
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    return fallback ?? "application/octet-stream";
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function caseSyncPollAttempts() {
    const configured = Number(process.env.CASE_SYNC_POLL_ATTEMPTS ?? 90);
    return Number.isFinite(configured)
        ? Math.max(1, Math.min(300, Math.floor(configured)))
        : 90;
}

function caseSyncPollIntervalMs() {
    const configured = Number(process.env.CASE_SYNC_POLL_INTERVAL_MS ?? 2000);
    return Number.isFinite(configured)
        ? Math.max(500, Math.min(10_000, Math.floor(configured)))
        : 2000;
}

function sizeOfBytes(bytes: ArrayBuffer | Buffer) {
    return bytes instanceof Buffer ? bytes.byteLength : bytes.byteLength;
}

function scoreForChunk(chunk: CaseVaultChunk): number | null {
    if (typeof chunk.hybridScore === "number") return chunk.hybridScore;
    if (typeof chunk.score === "number") return chunk.score;
    if (typeof chunk.distance === "number") return 1 / (1 + chunk.distance);
    return null;
}

function chunkIndex(chunk: CaseVaultChunk): number | null {
    if (typeof chunk.chunk_index === "number") return chunk.chunk_index;
    if (typeof chunk.index === "number") return chunk.index;
    return null;
}

function combineChunkText(chunks: CaseVaultChunk[]): string {
    return chunks
        .map((chunk) => {
            const index = chunkIndex(chunk);
            const label = index === null ? "Chunk" : `Chunk ${index}`;
            return `[${label}]\n${chunk.text}`;
        })
        .join("\n\n")
        .trim();
}

async function hydrateSearchChunk(params: {
    client: CaseClient;
    vaultId: string;
    objectId: string;
    chunk: CaseVaultChunk;
}): Promise<CaseVaultChunk[]> {
    const index = chunkIndex(params.chunk);
    if (index === null) return [params.chunk];
    try {
        const result = await params.client.getVaultObjectChunks({
            vaultId: params.vaultId,
            objectId: params.objectId,
            start: Math.max(0, index - 1),
            end: index + 1,
        });
        const chunks = result.chunks?.length ? result.chunks : [params.chunk];
        return chunks.map((chunk) => ({
            ...chunk,
            object_id: params.objectId,
        }));
    } catch (err) {
        console.error("[case-grounding] chunk hydration failed", err);
        return [params.chunk];
    }
}

async function ownerForDocument(params: {
    userId: string;
    projectId: string | null;
    db: Db;
}): Promise<{ ownerUserId: string; projectName?: string | null }> {
    if (!params.projectId) return { ownerUserId: params.userId };
    const { data: project } = await params.db
        .from("projects")
        .select("user_id, name")
        .eq("id", params.projectId)
        .maybeSingle();
    return {
        ownerUserId: String(project?.user_id ?? params.userId),
        projectName: (project?.name as string | null | undefined) ?? null,
    };
}

async function upsertDocumentLink(
    db: Db,
    values: Record<string, unknown>,
): Promise<void> {
    const now = new Date().toISOString();
    await db.from("case_document_links").upsert(
        {
            ...values,
            role: values.role ?? "source",
            updated_at: now,
        },
        { onConflict: "document_id,version_id,role" },
    );
}

export async function syncDocumentVersionToCase(params: {
    documentId: string;
    versionId: string;
    userId: string;
    projectId: string | null;
    filename: string;
    contentType?: string | null;
    bytes: ArrayBuffer | Buffer;
    db: Db;
}): Promise<void> {
    const contentHash = hashBytes(params.bytes);
    const { data: version } = await params.db
        .from("document_versions")
        .select("storage_path")
        .eq("id", params.versionId)
        .maybeSingle();
    const storageRef = parseCaseStorageUri((version?.storage_path as string | null) ?? "");
    if (!storageRef) {
        await upsertDocumentLink(params.db, {
            document_id: params.documentId,
            version_id: params.versionId,
            role: "source",
            content_hash: contentHash,
            filename: params.filename,
            content_type: contentTypeForFilename(params.filename, params.contentType),
            size_bytes: sizeOfBytes(params.bytes),
            sync_status: "skipped",
            ingestion_status: null,
            error: "Legacy storage object has not been migrated into Case Vault.",
        });
        return;
    }
    const existing = await params.db
        .from("case_document_links")
        .select("content_hash, sync_status")
        .eq("document_id", params.documentId)
        .eq("version_id", params.versionId)
        .eq("role", "source")
        .maybeSingle();
    if (
        existing.data?.content_hash === contentHash &&
        existing.data?.sync_status === "completed"
    ) {
        return;
    }

    const owner = await ownerForDocument({
        userId: params.userId,
        projectId: params.projectId,
        db: params.db,
    });
    const effectiveKey = await getEffectiveCaseApiKey(owner.ownerUserId, params.db).catch(
        (err) => {
            console.error("[case-sync] failed to decrypt Case key", err);
            return null;
        },
    );
    if (!effectiveKey) {
        await upsertDocumentLink(params.db, {
            document_id: params.documentId,
            version_id: params.versionId,
            role: "source",
            content_hash: contentHash,
            filename: params.filename,
            content_type: contentTypeForFilename(params.filename, params.contentType),
            size_bytes: sizeOfBytes(params.bytes),
            sync_status: "skipped",
            ingestion_status: null,
            error: "Project owner has not configured a verified Case.dev API key.",
        });
        return;
    }

    const client = caseClientForEffectiveKey(effectiveKey, {
        userId: owner.ownerUserId,
        db: params.db,
        service: "vault",
        operation: "vault.ingest",
    });
    const contentType = contentTypeForFilename(params.filename, params.contentType);
    const sizeBytes = sizeOfBytes(params.bytes);

    try {
        const vaultLink = await ensureCaseVaultLink({
            db: params.db,
            ownerUserId: owner.ownerUserId,
            projectId: params.projectId,
            projectName: owner.projectName,
            client,
        });
        await upsertDocumentLink(params.db, {
            document_id: params.documentId,
            version_id: params.versionId,
            role: "source",
            vault_link_id: vaultLink.id,
            case_vault_id: storageRef.vaultId,
            case_object_id: storageRef.objectId,
            content_hash: contentHash,
            filename: params.filename,
            content_type: contentType,
            size_bytes: sizeBytes,
            sync_status: "ingesting",
            ingestion_status: "processing",
            error: null,
        });

        await client.ingestVaultObject(storageRef.vaultId, storageRef.objectId);
        let object = await client.getVaultObject(storageRef.vaultId, storageRef.objectId);
        for (let i = 0; i < caseSyncPollAttempts(); i++) {
            if (
                object.ingestionStatus === "completed" ||
                object.ingestionStatus === "failed"
            ) {
                break;
            }
            await sleep(caseSyncPollIntervalMs());
            object = await client.getVaultObject(storageRef.vaultId, storageRef.objectId);
        }

        const completed = object.ingestionStatus === "completed";
        const failed = object.ingestionStatus === "failed";
        await upsertDocumentLink(params.db, {
            document_id: params.documentId,
            version_id: params.versionId,
            role: "source",
            vault_link_id: vaultLink.id,
            case_vault_id: storageRef.vaultId,
            case_object_id: storageRef.objectId,
            content_hash: contentHash,
            filename: params.filename,
            content_type: contentType,
            size_bytes: sizeBytes,
            sync_status: completed ? "completed" : failed ? "failed" : "ingesting",
            ingestion_status: object.ingestionStatus ?? null,
            page_count: object.pageCount ?? null,
            text_length: object.textLength ?? null,
            chunk_count: object.chunkCount ?? null,
            vector_count: object.vectorCount ?? null,
            transcript_object_id: object.transcript_object_id ?? null,
            object_metadata: object.metadata ?? {},
            last_seen_at: new Date().toISOString(),
            error: completed
                ? null
                : failed
                  ? object.ingestionError ?? "Case.dev ingestion failed."
                  : null,
            last_synced_at: new Date().toISOString(),
        });
    } catch (err) {
        const detail =
            err instanceof CaseApiError
                ? `${err.status}: ${err.body.slice(0, 500)}`
                : err instanceof Error
                  ? err.message
                  : String(err);
        console.error("[case-sync] document sync failed", detail);
        await upsertDocumentLink(params.db, {
            document_id: params.documentId,
            version_id: params.versionId,
            role: "source",
            content_hash: contentHash,
            filename: params.filename,
            content_type: contentType,
            size_bytes: sizeBytes,
            sync_status: "failed",
            error: detail,
        });
    }
}

export async function registerCaseStoredObject(params: {
    documentId: string;
    versionId: string;
    userId: string;
    projectId: string | null;
    storageUri: string | null;
    filename: string;
    contentType?: string | null;
    bytes?: ArrayBuffer | Buffer | null;
    role: CaseBlobRole;
    db: Db;
}): Promise<void> {
    if (!params.storageUri) return;
    const storageRef = parseCaseStorageUri(params.storageUri);
    if (!storageRef) return;
    const owner = await ownerForDocument({
        userId: params.userId,
        projectId: params.projectId,
        db: params.db,
    });
    const effectiveKey = await getEffectiveCaseApiKey(owner.ownerUserId, params.db);
    if (!effectiveKey) return;
    const client = caseClientForEffectiveKey(effectiveKey, {
        userId: owner.ownerUserId,
        db: params.db,
        service: "vault",
        operation: "vault.register",
    });
    const vaultLink = await ensureCaseVaultLink({
        db: params.db,
        ownerUserId: owner.ownerUserId,
        projectId: params.projectId,
        projectName: owner.projectName,
        client,
    });
    await upsertDocumentLink(params.db, {
        document_id: params.documentId,
        version_id: params.versionId,
        role: params.role,
        vault_link_id: vaultLink.id,
        case_vault_id: storageRef.vaultId,
        case_object_id: storageRef.objectId,
        content_hash: params.bytes ? hashBytes(params.bytes) : null,
        filename: params.filename,
        content_type: contentTypeForFilename(params.filename, params.contentType),
        size_bytes: params.bytes ? sizeOfBytes(params.bytes) : null,
        sync_status: "completed",
        ingestion_status: params.role === "source" ? "completed" : null,
        object_metadata: {},
        last_seen_at: new Date().toISOString(),
        error: null,
        last_synced_at: new Date().toISOString(),
    });
}

async function getOwnerEffectiveKeyForLinkedDocument(
    documentId: string,
    db: Db,
): Promise<{ ownerUserId: string; effective: EffectiveCaseApiKey } | null> {
    const { data: doc } = await db
        .from("documents")
        .select("user_id, project_id")
        .eq("id", documentId)
        .maybeSingle();
    if (!doc) return null;
    const owner = await ownerForDocument({
        userId: String(doc.user_id),
        projectId: (doc.project_id as string | null) ?? null,
        db,
    });
    return getEffectiveCaseApiKey(owner.ownerUserId, db)
        .then((effective) => (effective ? { ownerUserId: owner.ownerUserId, effective } : null))
        .catch(() => null);
}

export async function getCaseTextForDocument(params: {
    documentId: string;
    versionId?: string | null;
    db: Db;
}): Promise<string | null> {
    const versionId =
        params.versionId ??
        (
            await params.db
                .from("documents")
                .select("current_version_id")
                .eq("id", params.documentId)
                .maybeSingle()
        ).data?.current_version_id;
    if (!versionId) return null;

    const { data: link } = await params.db
        .from("case_document_links")
        .select("*")
        .eq("document_id", params.documentId)
        .eq("version_id", versionId)
        .eq("role", "source")
        .eq("sync_status", "completed")
        .maybeSingle();
    const linked = link as DocumentLink | null;
    if (!linked?.case_vault_id || !linked.case_object_id) return null;

    const ownerKey = await getOwnerEffectiveKeyForLinkedDocument(params.documentId, params.db);
    if (!ownerKey) return null;
    try {
        const client = caseClientForEffectiveKey(ownerKey.effective, {
            userId: ownerKey.ownerUserId,
            db: params.db,
            service: "vault",
            operation: "vault.read_text",
        });
        const result = await client.getVaultObjectText(
            linked.case_vault_id,
            linked.case_object_id,
        );
        return result.text?.trim() || null;
    } catch (err) {
        console.error("[case-grounding] object text failed", err);
        return null;
    }
}

async function sourceLinksForScope(params: {
    documentIds?: string[];
    projectId?: string | null;
    db: Db;
}): Promise<DocumentLink[]> {
    let linkQuery = params.db
        .from("case_document_links")
        .select(
            "document_id, version_id, role, vault_link_id, case_vault_id, case_object_id, sync_status, ingestion_status, filename, text_length, chunk_count, vector_count, graph_status, transcript_object_id, object_metadata, last_seen_at, page_count, error, last_synced_at",
        )
        .eq("role", "source");
    if (params.documentIds?.length) {
        linkQuery = linkQuery.in("document_id", params.documentIds);
    } else if (params.projectId) {
        const { data: docs } = await params.db
            .from("documents")
            .select("id")
            .eq("project_id", params.projectId)
            .eq("status", "ready");
        const ids = ((docs ?? []) as { id: string }[]).map((doc) => doc.id);
        if (!ids.length) return [];
        linkQuery = linkQuery.in("document_id", ids);
    } else {
        return [];
    }
    const { data } = await linkQuery;
    return (data ?? []) as unknown as DocumentLink[];
}

export async function listCaseVaultDocuments(params: {
    documentIds?: string[];
    projectId?: string | null;
    labelByDocumentId?: Map<string, string>;
    db: Db;
}): Promise<CaseVaultDocumentInfo[]> {
    const links = await sourceLinksForScope(params);
    return links.map((link) => ({
        doc_id: params.labelByDocumentId?.get(link.document_id) ?? null,
        document_id: link.document_id,
        version_id: link.version_id,
        filename: link.filename,
        case_vault_id: link.case_vault_id,
        case_object_id: link.case_object_id,
        sync_status: link.sync_status,
        ingestion_status: link.ingestion_status,
        searchable:
            link.sync_status === "completed" &&
            link.ingestion_status === "completed" &&
            !!link.case_vault_id &&
            !!link.case_object_id,
        page_count: (link as any).page_count ?? null,
        text_length: link.text_length,
        chunk_count: link.chunk_count,
        vector_count: link.vector_count ?? null,
        graph_status: link.graph_status ?? null,
        transcript_object_id: link.transcript_object_id ?? null,
        error: (link as any).error ?? null,
        last_synced_at: (link as any).last_synced_at ?? null,
        last_seen_at: link.last_seen_at ?? null,
    }));
}

export async function getCaseDocumentContext(params: {
    documentId: string;
    versionId?: string | null;
    chunkIndex: number;
    before?: number;
    after?: number;
    db: Db;
}): Promise<CaseDocumentContextResponse> {
    const versionId =
        params.versionId ??
        (
            await params.db
                .from("documents")
                .select("current_version_id")
                .eq("id", params.documentId)
                .maybeSingle()
        ).data?.current_version_id;
    if (!versionId) return { ok: false, error: "Document version not found." };

    const { data: link } = await params.db
        .from("case_document_links")
        .select("*")
        .eq("document_id", params.documentId)
        .eq("version_id", versionId)
        .eq("role", "source")
        .maybeSingle();
    const linked = link as DocumentLink | null;
    if (!linked?.case_vault_id || !linked.case_object_id) {
        return { ok: false, error: "Document is not linked to a Case.dev Vault object." };
    }
    if (linked.sync_status !== "completed" || linked.ingestion_status !== "completed") {
        return {
            ok: false,
            document_id: linked.document_id,
            version_id: linked.version_id,
            filename: linked.filename,
            error: `Document is ${linked.ingestion_status ?? linked.sync_status}; Case.dev context is not ready yet.`,
        };
    }

    const ownerKey = await getOwnerEffectiveKeyForLinkedDocument(params.documentId, params.db);
    if (!ownerKey) return { ok: false, error: "Case.dev API key is not available." };
    const client = caseClientForEffectiveKey(ownerKey.effective, {
        userId: ownerKey.ownerUserId,
        db: params.db,
        service: "vault",
        operation: "vault.get_context",
    });
    const before = Math.max(0, Math.min(10, params.before ?? 1));
    const after = Math.max(0, Math.min(10, params.after ?? 1));
    const start = Math.max(0, params.chunkIndex - before);
    const end = params.chunkIndex + after;
    const result = await client.getVaultObjectChunks({
        vaultId: linked.case_vault_id,
        objectId: linked.case_object_id,
        start,
        end,
    });
    let ocrWords: CaseDocumentContextResponse["ocr_words"] = { available: false };
    const hasWordRange = (result.chunks ?? []).some(
        (chunk) =>
            typeof chunk.word_start_index === "number" ||
            typeof chunk.word_end_index === "number",
    );
    if (hasWordRange) {
        try {
            const words = await client.getVaultObjectOcrWords(
                linked.case_vault_id,
                linked.case_object_id,
            );
            ocrWords = {
                available: true,
                total_words: words.totalWords ?? null,
                note:
                    "OCR word bounding boxes are available for precise PDF highlighting; chat receives word index ranges, not the full coordinate payload.",
            };
        } catch {
            ocrWords = { available: false, note: "OCR words were not available for this object." };
        }
    }

    return {
        ok: true,
        document_id: linked.document_id,
        version_id: linked.version_id,
        filename: linked.filename,
        case_vault_id: linked.case_vault_id,
        case_object_id: linked.case_object_id,
        chunk_index: params.chunkIndex,
        total_chunks: result.total_chunks,
        chunks: (result.chunks ?? []).map((chunk) => ({
            index: chunkIndex(chunk),
            page_start: chunk.page_start ?? null,
            page_end: chunk.page_end ?? null,
            word_start_index: chunk.word_start_index ?? null,
            word_end_index: chunk.word_end_index ?? null,
            text: chunk.text,
        })),
        ocr_words: ocrWords,
    };
}

export async function searchCaseDocuments(params: {
    query: string;
    documentIds?: string[];
    projectId?: string | null;
    topK?: number;
    method?: CaseVaultSearchMethod;
    db: Db;
}): Promise<CaseDocumentSearchResponse> {
    if (!params.documentIds?.length && !params.projectId) {
        return {
            hits: [],
            searched_object_count: 0,
            method: params.method ?? "hybrid",
            skipped_reason:
                "Case.dev search needs either explicitly attached documents or a project scope.",
        };
    }

    const links = (await sourceLinksForScope(params)).filter(
        (link) => link.sync_status === "completed",
    );
    const byVault = new Map<string, DocumentLink[]>();
    for (const link of links) {
        if (!link.case_vault_id || !link.case_object_id) continue;
        const rows = byVault.get(link.case_vault_id) ?? [];
        rows.push(link);
        byVault.set(link.case_vault_id, rows);
    }

    const hits: CaseDocumentSearchHit[] = [];
    let searchedObjectCount = 0;
    let synthesizedResponse: string | null = null;
    const sources: unknown[] = [];
    for (const [vaultId, rows] of byVault.entries()) {
        const ownerKey = await getOwnerEffectiveKeyForLinkedDocument(rows[0].document_id, params.db);
        if (!ownerKey) continue;
        const client = caseClientForEffectiveKey(ownerKey.effective, {
            userId: ownerKey.ownerUserId,
            db: params.db,
            service: "vault",
            operation: "vault.search",
        });
        const linkByObjectId = new Map(
            rows
                .filter((row) => row.case_object_id)
                .map((row) => [row.case_object_id as string, row]),
        );
        searchedObjectCount += linkByObjectId.size;
        try {
            const result = await client.searchVault({
                vaultId,
                query: params.query,
                method: params.method ?? "hybrid",
                topK: params.topK ?? 10,
                filters: {
                    object_id: rows.map((row) => row.case_object_id),
                },
            });
            if (result.response && !synthesizedResponse) {
                synthesizedResponse = result.response;
            }
            if (Array.isArray(result.sources)) sources.push(...result.sources);
            const seen = new Set<string>();
            for (const chunk of result.chunks ?? []) {
                const objectId = chunk.object_id ?? chunk.source;
                if (!objectId) continue;
                const link = linkByObjectId.get(objectId);
                if (!link?.case_vault_id || !link.case_object_id) continue;
                const index = chunkIndex(chunk);
                const dedupeKey = `${objectId}:${index ?? chunk.text.slice(0, 80)}`;
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                const surrounding = await hydrateSearchChunk({
                    client,
                    vaultId,
                    objectId,
                    chunk,
                });
                const pages = surrounding
                    .flatMap((item) => [item.page_start, item.page_end])
                    .filter((page): page is number => typeof page === "number");
                hits.push({
                    document_id: link.document_id,
                    version_id: link.version_id,
                    case_vault_id: link.case_vault_id,
                    case_object_id: link.case_object_id,
                    filename: link.filename,
                    chunk_index: index,
                    page_start: pages.length ? Math.min(...pages) : chunk.page_start ?? null,
                    page_end: pages.length ? Math.max(...pages) : chunk.page_end ?? null,
                    score: scoreForChunk(chunk),
                    preview_text: chunk.text,
                    text: combineChunkText(surrounding) || chunk.text,
                    surrounding_chunks: surrounding.map((item) => ({
                        index: chunkIndex(item),
                        page_start: item.page_start ?? null,
                        page_end: item.page_end ?? null,
                        text: item.text,
                    })),
                });
            }
        } catch (err) {
            console.error("[case-grounding] vault search failed", err);
        }
    }
    hits.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return {
        hits: hits.slice(0, params.topK ?? 10),
        searched_object_count: searchedObjectCount,
        method: params.method ?? "hybrid",
        response: synthesizedResponse,
        sources,
    };
}
