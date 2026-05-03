import type { createServerDb } from "./db";
import {
    CaseApiError,
    CaseClient,
    type CaseVaultChunk,
} from "./caseClient";
import { getEffectiveCaseApiKey } from "./caseCredentials";
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
    skipped_reason?: string;
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

    const client = new CaseClient(effectiveKey.apiKey);
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
        for (let i = 0; i < 15; i++) {
            if (
                object.ingestionStatus === "completed" ||
                object.ingestionStatus === "failed"
            ) {
                break;
            }
            await sleep(2000);
            object = await client.getVaultObject(storageRef.vaultId, storageRef.objectId);
        }

        const completed = object.ingestionStatus === "completed";
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
            sync_status: completed ? "completed" : "failed",
            ingestion_status: object.ingestionStatus ?? null,
            page_count: object.pageCount ?? null,
            text_length: object.textLength ?? null,
            chunk_count: object.chunkCount ?? null,
            error: completed
                ? null
                : object.ingestionError ?? "Case.dev ingestion did not complete.",
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
    const client = new CaseClient(effectiveKey.apiKey);
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
        error: null,
        last_synced_at: new Date().toISOString(),
    });
}

async function getOwnerKeyForLinkedDocument(
    documentId: string,
    db: Db,
): Promise<string | null> {
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
        .then((key) => key?.apiKey ?? null)
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

    const apiKey = await getOwnerKeyForLinkedDocument(params.documentId, params.db);
    if (!apiKey) return null;
    try {
        const client = new CaseClient(apiKey);
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

export async function searchCaseDocuments(params: {
    query: string;
    documentIds?: string[];
    projectId?: string | null;
    topK?: number;
    db: Db;
}): Promise<CaseDocumentSearchResponse> {
    if (!params.documentIds?.length && !params.projectId) {
        return {
            hits: [],
            searched_object_count: 0,
            skipped_reason:
                "Case.dev search needs either explicitly attached documents or a project scope.",
        };
    }

    let linkQuery = params.db
        .from("case_document_links")
        .select(
            "document_id, version_id, role, vault_link_id, case_vault_id, case_object_id, sync_status, ingestion_status, filename, text_length, chunk_count",
        )
        .eq("role", "source")
        .eq("sync_status", "completed");
    if (params.documentIds?.length) {
        linkQuery = linkQuery.in("document_id", params.documentIds);
    } else if (params.projectId) {
        const { data: docs } = await params.db
            .from("documents")
            .select("id")
            .eq("project_id", params.projectId)
            .eq("status", "ready");
        const ids = ((docs ?? []) as { id: string }[]).map((doc) => doc.id);
        if (!ids.length) return { hits: [], searched_object_count: 0 };
        linkQuery = linkQuery.in("document_id", ids);
    }

    const { data: links } = await linkQuery;
    const byVault = new Map<string, DocumentLink[]>();
    for (const link of (links ?? []) as unknown as DocumentLink[]) {
        if (!link.case_vault_id || !link.case_object_id) continue;
        const rows = byVault.get(link.case_vault_id) ?? [];
        rows.push(link);
        byVault.set(link.case_vault_id, rows);
    }

    const hits: CaseDocumentSearchHit[] = [];
    let searchedObjectCount = 0;
    for (const [vaultId, rows] of byVault.entries()) {
        const apiKey = await getOwnerKeyForLinkedDocument(rows[0].document_id, params.db);
        if (!apiKey) continue;
        const client = new CaseClient(apiKey);
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
                method: "hybrid",
                topK: params.topK ?? 10,
                filters: {
                    object_id: rows.map((row) => row.case_object_id),
                },
            });
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
    };
}
