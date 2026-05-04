/**
 * Mike API client — all requests to the Node.js backend.
 * Uses Better Auth's HTTP-only cookie session for user authentication.
 */

import type {
    AssistantEvent,
    MikeChat,
    MikeChatDetailOut,
    MikeCitationAnnotation,
    MikeDocument,
    MikeFolder,
    MikeMessage,
    MikeProject,
    MikeWorkflow,
    TabularReview,
    TabularReviewDetailOut,
} from "@/app/components/shared/types";
import type { ModelOption } from "@/app/lib/caseModels";

// Server-side shape before mapping
interface ServerMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: { filename: string; document_id?: string }[] | null;
    workflow?: { id: string; title: string } | null;
    annotations?: MikeCitationAnnotation[] | null;
    created_at: string;
}
interface ServerChatDetailOut {
    chat: MikeChat;
    messages: ServerMessage[];
}

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const { headers: initHeaders, ...restInit } = init ?? {};
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        credentials: "include",
        ...restInit,
        headers: {
            Accept: "application/json",
            ...(initHeaders as Record<string, string> | undefined),
        },
    });

    if (!response.ok) {
        const detail = await response.text();
        let message = detail;
        try {
            const parsed = JSON.parse(detail) as { detail?: string; error?: string };
            message = parsed.detail ?? parsed.error ?? message;
        } catch {
            /* keep raw response text */
        }
        throw new Error(message || `API error: ${response.status}`);
    }

    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Matters. The exported names retain "Project" for compatibility with
// existing components while the backend aliases move to Case Matter routes.
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<MikeProject[]> {
    return apiRequest<MikeProject[]>("/matters");
}

export async function createProject(
    name: string,
    cm_number?: string,
    shared_with?: string[],
    matter?: {
        practice_area?: string | null;
        matter_type?: string | null;
        client_name?: string | null;
        responsible_attorney?: string | null;
    },
): Promise<MikeProject> {
    return apiRequest<MikeProject>("/matters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cm_number, shared_with, ...matter }),
    });
}

export async function deleteAccount(): Promise<void> {
    return apiRequest<void>("/user/account", { method: "DELETE" });
}

export interface UserProfileRow {
    id: string;
    user_id: string;
    display_name: string | null;
    organisation: string | null;
    tier: string | null;
    message_credits_used: number;
    credits_reset_date: string;
    tabular_model: string | null;
    created_at: string;
    updated_at: string;
}

export async function getUserProfile(): Promise<UserProfileRow> {
    return apiRequest<UserProfileRow>("/user/profile");
}

export async function updateUserProfile(
    payload: Partial<
        Pick<
            UserProfileRow,
            | "display_name"
            | "organisation"
            | "tabular_model"
            | "message_credits_used"
            | "credits_reset_date"
        >
    >,
): Promise<UserProfileRow> {
    return apiRequest<UserProfileRow>("/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export interface CaseApiKeyStatus {
    configured: boolean;
    last4: string | null;
    status: "verified" | "unverified" | "invalid" | "missing";
    verified_at: string | null;
    last_checked_at: string | null;
    source: "user" | "server" | "demo" | "missing";
    capabilities: {
        llm: boolean;
        vault: boolean;
        skills: boolean;
        matters: boolean;
        legal: boolean;
        model_count: number | null;
    };
    error: string | null;
}

export interface CaseModelCatalog {
    source: "live" | "fallback";
    key_source: "user" | "server" | "demo" | "missing";
    models: ModelOption[];
    error?: string;
}

export type ProviderId = "anthropic" | "gemini";

export interface ProviderCredentialStatus {
    provider: ProviderId;
    label: string;
    configured: boolean;
    last4: string | null;
    status: "verified" | "unverified" | "invalid" | "missing";
    verified_at: string | null;
    last_checked_at: string | null;
    source: "user" | "server" | "demo" | "missing";
    capabilities: {
        llm: boolean;
        model_count: number | null;
    };
    error: string | null;
}

export async function getCaseApiKeyStatus(): Promise<CaseApiKeyStatus> {
    return apiRequest<CaseApiKeyStatus>("/user/case-api-key");
}

export async function saveCaseApiKey(
    apiKey: string | null,
): Promise<CaseApiKeyStatus> {
    return apiRequest<CaseApiKeyStatus>("/user/case-api-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
    });
}

export async function getCaseModelCatalog(): Promise<CaseModelCatalog> {
    return apiRequest<CaseModelCatalog>("/user/case-models");
}

export async function getProviderCredentialStatuses(): Promise<
    ProviderCredentialStatus[]
> {
    return apiRequest<ProviderCredentialStatus[]>("/user/provider-credentials");
}

export async function saveProviderApiKey(
    provider: ProviderId,
    apiKey: string | null,
): Promise<ProviderCredentialStatus> {
    return apiRequest<ProviderCredentialStatus>(
        `/user/provider-credentials/${provider}`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: apiKey }),
        },
    );
}

export interface DemoUsageStatus {
    enabled: boolean;
    limit_usd: number;
    spent_usd: number;
    reserved_usd: number;
    remaining_usd: number;
    blocked: boolean;
    global_remaining_usd?: number | null;
}

export async function getDemoUsage(): Promise<DemoUsageStatus> {
    return apiRequest<DemoUsageStatus>("/user/demo-usage");
}

export interface CaseSkillSummary {
    slug: string;
    name: string;
    summary: string | null;
    tags: string[];
    score: number | null;
    source: "curated" | "custom" | null;
    version?: string | null;
    author_name?: string | null;
    license?: string | null;
}

export interface CaseSkillDetail extends CaseSkillSummary {
    content: string;
    metadata?: Record<string, unknown> | null;
    bundle?: Record<string, unknown> | null;
}

export interface CaseSkillFavorite extends CaseSkillSummary {
    favorited_at: string;
}

export interface CaseSkillSearchResponse {
    key_source: "user" | "server" | "demo" | "missing";
    methods_used: string[];
    results: CaseSkillSummary[];
}

export interface CaseSkillListResponse {
    key_source: "user" | "server" | "demo" | "missing";
    skills: CaseSkillSummary[];
    next_cursor: string | null;
    has_more: boolean;
}

export async function getProject(projectId: string): Promise<MikeProject> {
    return apiRequest<MikeProject>(`/matters/${projectId}`);
}

export async function updateProject(
    projectId: string,
    payload: {
        name?: string;
        cm_number?: string;
        shared_with?: string[];
        matter_status?: string | null;
        practice_area?: string | null;
        matter_type?: string | null;
        client_name?: string | null;
        responsible_attorney?: string | null;
    },
): Promise<MikeProject> {
    return apiRequest<MikeProject>(`/matters/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteProject(projectId: string): Promise<void> {
    await apiRequest(`/matters/${projectId}`, { method: "DELETE" });
}

export interface ProjectPeople {
    owner: {
        user_id: string;
        email: string | null;
        display_name: string | null;
    };
    members: { email: string; display_name: string | null }[];
}

export async function getProjectPeople(
    projectId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/matters/${projectId}/people`);
}

export interface MatterLogEntry {
    id: string;
    source?: "case" | "mike" | string;
    event_type?: string;
    summary?: string;
    details?: Record<string, unknown> | null;
    created_at?: string;
    occurred_at?: string;
}

export interface MatterWorkItem {
    id: string;
    title?: string;
    description?: string | null;
    type?: string | null;
    status?: string | null;
    priority?: string | null;
    instructions?: string | null;
    due_at?: string | null;
    created_at?: string;
    updated_at?: string;
}

export async function listMatterLog(projectId: string): Promise<MatterLogEntry[]> {
    return apiRequest<MatterLogEntry[]>(`/matters/${projectId}/matter-log`);
}

export async function listMatterWorkItems(
    projectId: string,
): Promise<MatterWorkItem[]> {
    return apiRequest<MatterWorkItem[]>(`/matters/${projectId}/work-items`);
}

export async function createMatterWorkItem(
    projectId: string,
    payload: {
        title: string;
        description?: string | null;
        type?: string;
        priority?: string;
        instructions?: string | null;
        due_at?: string | null;
    },
): Promise<MatterWorkItem> {
    return apiRequest<MatterWorkItem>(`/matters/${projectId}/work-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateMatterWorkItem(
    projectId: string,
    workItemId: string,
    payload: Partial<MatterWorkItem>,
): Promise<MatterWorkItem> {
    return apiRequest<MatterWorkItem>(
        `/matters/${projectId}/work-items/${workItemId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function decideMatterWorkItem(
    projectId: string,
    workItemId: string,
    payload: {
        decision: "approve" | "revise" | "block" | "reassign";
        reason?: string | null;
        agent_type_id?: string | null;
        metadata?: Record<string, unknown>;
    },
): Promise<MatterWorkItem> {
    return apiRequest<MatterWorkItem>(
        `/matters/${projectId}/work-items/${workItemId}/decision`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
    projectId: string,
    name: string,
    parentFolderId?: string | null,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(`/matters/${projectId}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function renameProjectFolder(
    projectId: string,
    folderId: string,
    name: string,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(
        `/matters/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        },
    );
}

export async function deleteProjectFolder(
    projectId: string,
    folderId: string,
): Promise<void> {
    await apiRequest(`/matters/${projectId}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveSubfolderToFolder(
    projectId: string,
    folderId: string,
    parentFolderId: string | null,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(
        `/matters/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent_folder_id: parentFolderId }),
        },
    );
}

export async function moveDocumentToFolder(
    projectId: string,
    documentId: string,
    folderId: string | null,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(
        `/matters/${projectId}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function addDocumentToProject(
    projectId: string,
    documentId: string,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(
        `/matters/${projectId}/documents/${documentId}`,
        { method: "POST" },
    );
}

export interface MikeDocumentVersion {
    id: string;
    version_number: number | null;
    source: string;
    created_at: string;
    display_name: string | null;
}

interface DirectUploadInstruction {
    method: "PUT";
    upload_url: string;
    headers: Record<string, string>;
    complete_url: string;
    expires_in: number;
}

interface DirectDocumentUploadSession {
    document: MikeDocument;
    version: MikeDocumentVersion;
    direct_upload: DirectUploadInstruction;
}

interface DirectVersionUploadSession {
    version: MikeDocumentVersion;
    direct_upload: DirectUploadInstruction;
}

export async function listDocumentVersions(
    documentId: string,
): Promise<{
    current_version_id: string | null;
    versions: MikeDocumentVersion[];
}> {
    return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
    documentId: string,
    file: File,
    displayName?: string,
): Promise<MikeDocumentVersion> {
    const session = await apiRequest<DirectVersionUploadSession>(
        `/single-documents/${documentId}/versions/direct-upload`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                filename: file.name,
                size_bytes: file.size,
                content_type: file.type,
                display_name: displayName,
            }),
        },
    );
    return completeDirectUpload<MikeDocumentVersion>(
        file,
        session.direct_upload,
    );
}

export async function renameDocumentVersion(
    documentId: string,
    versionId: string,
    displayName: string | null,
): Promise<MikeDocumentVersion> {
    return apiRequest<MikeDocumentVersion>(
        `/single-documents/${documentId}/versions/${versionId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ display_name: displayName }),
        },
    );
}

export async function uploadProjectDocument(
    projectId: string,
    file: File,
): Promise<MikeDocument> {
    return uploadDocumentDirect(file, projectId);
}

export async function uploadStandaloneDocument(
    file: File,
): Promise<MikeDocument> {
    return uploadDocumentDirect(file, null);
}

async function uploadDocumentDirect(
    file: File,
    projectId: string | null,
): Promise<MikeDocument> {
    const session = await apiRequest<DirectDocumentUploadSession>(
        "/single-documents/direct-upload",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                filename: file.name,
                size_bytes: file.size,
                content_type: file.type,
                project_id: projectId,
            }),
        },
    );
    return completeDirectUpload<MikeDocument>(file, session.direct_upload);
}

async function completeDirectUpload<T>(
    file: File,
    instruction: DirectUploadInstruction,
): Promise<T> {
    const upload = await fetch(instruction.upload_url, {
        method: instruction.method,
        headers: instruction.headers,
        body: file,
    });
    if (!upload.ok) {
        const detail = await upload.text().catch(() => "");
        throw new Error(detail || `Upload failed: ${upload.status}`);
    }
    const etag = upload.headers.get("etag");
    const complete = await fetch(`${API_BASE}${instruction.complete_url}`, {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ size_bytes: file.size, etag }),
    });
    if (!complete.ok) {
        const detail = await complete.text();
        throw new Error(detail || `Upload finalize failed: ${complete.status}`);
    }
    return complete.json() as Promise<T>;
}

export async function listStandaloneDocuments(): Promise<MikeDocument[]> {
    return apiRequest<MikeDocument[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
    await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
    documentId: string,
    versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
    const qs = versionId
        ? `?version_id=${encodeURIComponent(versionId)}`
        : "";
    return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

export interface DocumentDownloadLink {
    document_id: string;
    filename: string;
    url: string;
    version_id: string | null;
}

export async function getDocumentDownloadLinks(
    documentIds: string[],
): Promise<DocumentDownloadLink[]> {
    const response = await fetch(`${API_BASE}/single-documents/download-zip`, {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ document_ids: documentIds }),
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `API error: ${response.status}`);
    }
    const payload = (await response.json()) as { files?: DocumentDownloadLink[] };
    return payload.files ?? [];
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
    project_id?: string;
}): Promise<{ id: string }> {
    return apiRequest<{ id: string }>("/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
}

export async function listChats(): Promise<MikeChat[]> {
    return apiRequest<MikeChat[]>("/chat");
}

export async function listProjectChats(projectId: string): Promise<MikeChat[]> {
    return apiRequest<MikeChat[]>(`/matters/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<MikeChatDetailOut> {
    const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
    const messages: MikeMessage[] = raw.messages.map((m) => {
        if (m.role === "user") {
            return {
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        return {
            role: "assistant",
            content:
                events
                    ?.filter((e) => e.type === "content")
                    .map((e) => (e as { type: "content"; text: string }).text)
                    .join("") ?? "",
            annotations: m.annotations ?? undefined,
            events,
        };
    });
    return { chat: raw.chat, messages };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function deleteChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

export async function generateChatTitle(
    chatId: string,
    message: string,
): Promise<{ title: string }> {
    return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
    });
}

export async function streamChat(payload: {
    messages: {
        role: string;
        content: string;
        files?: { filename: string; document_id?: string }[];
        workflow?: { id: string; title: string };
    }[];
    chat_id?: string;
    project_id?: string;
    model?: string;
    signal?: AbortSignal;
}): Promise<Response> {
    const { signal, ...body } = payload;
    return fetch(`${API_BASE}/chat`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
    });
}

type StreamChatMessage = {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
    projectId: string;
    messages: StreamChatMessage[];
    chat_id?: string;
    model?: string;
    displayed_doc?: { filename: string; document_id: string };
    attached_documents?: { filename: string; document_id: string }[];
    signal?: AbortSignal;
}): Promise<Response> {
    const { projectId, signal, ...body } = payload;
    return fetch(`${API_BASE}/matters/${projectId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
    });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
): Promise<TabularReview[]> {
    const qs = projectId
        ? `?project_id=${encodeURIComponent(projectId)}`
        : "";
    return apiRequest<TabularReview[]>(`/tabular-review${qs}`);
}

export async function createTabularReview(payload: {
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
}): Promise<TabularReview> {
    return apiRequest<TabularReview>("/tabular-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReview(
    reviewId: string,
): Promise<TabularReviewDetailOut> {
    return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
    reviewId: string,
    payload: {
        title?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        document_ids?: string[];
        project_id?: string | null;
        shared_with?: string[];
    },
): Promise<TabularReview> {
    return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReviewPeople(
    reviewId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
    title: string,
    options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
    return apiRequest<{
        prompt: string;
        source: "preset" | "llm" | "fallback";
    }>("/tabular-review/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title,
            format: options?.format,
            documentName: options?.documentName,
            tags: options?.tags,
        }),
    });
}

export async function uploadReviewDocument(
    reviewId: string,
    file: File,
    options?: {
        projectId?: string;
        documentIds?: string[];
        columnsConfig?: { index: number; name: string; prompt: string }[];
    },
): Promise<MikeDocument> {
    const uploaded = options?.projectId
        ? await uploadProjectDocument(options.projectId, file)
        : await uploadStandaloneDocument(file);

    await updateTabularReview(reviewId, {
        columns_config: options?.columnsConfig,
        document_ids: [...(options?.documentIds ?? []), uploaded.id],
    });

    return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
    reviewId: string,
): Promise<Response> {
    return fetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
        method: "POST",
        credentials: "include",
    });
}

export async function streamTabularChat(
    reviewId: string,
    messages: { role: string; content: string }[],
    chat_id?: string | null,
    signal?: AbortSignal,
    context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<Response> {
    return fetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            messages,
            chat_id: chat_id ?? undefined,
            review_title: context?.reviewTitle ?? undefined,
            project_name: context?.projectName ?? undefined,
        }),
        signal: signal ?? undefined,
    });
}

export interface TRCitationAnnotation {
    type: "tabular_citation";
    ref: number;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
    quote: string;
}

interface RawTRMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    annotations?: TRCitationAnnotation[] | null;
    created_at: string;
}

export interface TRDisplayMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
}

export interface TRChat {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
    return raw.map((m) => {
        if (m.role === "user") {
            return {
                role: "user" as const,
                content: typeof m.content === "string" ? m.content : "",
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        const content =
            events
                ?.filter((e) => e.type === "content")
                .map((e) => (e as { type: "content"; text: string }).text)
                .join("") ?? "";
        return {
            role: "assistant" as const,
            content,
            events,
            annotations: m.annotations ?? undefined,
        };
    });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
    return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
    reviewId: string,
    chatId: string,
): Promise<RawTRMessage[]> {
    return apiRequest<RawTRMessage[]>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
    );
}

export async function deleteTabularChat(
    reviewId: string,
    chatId: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "DELETE",
    });
}

export async function regenerateTabularCell(
    reviewId: string,
    documentId: string,
    columnIndex: number,
): Promise<{
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
}> {
    return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            document_id: documentId,
            column_index: columnIndex,
        }),
    });
}

export async function clearTabularCells(
    reviewId: string,
    documentIds: string[],
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: documentIds }),
    });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = MikeWorkflow["type"];

export async function listWorkflows(
    type: WorkflowType,
): Promise<MikeWorkflow[]> {
    return apiRequest<MikeWorkflow[]>(`/workflows?type=${type}`);
}

export async function getWorkflow(workflowId: string): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
    title: string;
    type: "assistant" | "tabular";
    prompt_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    practice?: string | null;
}): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>("/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function searchCaseSkills(
    query: string,
    limit = 10,
): Promise<CaseSkillSearchResponse> {
    const params = new URLSearchParams({
        q: query,
        limit: String(limit),
    });
    return apiRequest<CaseSkillSearchResponse>(
        `/workflows/skills/search?${params.toString()}`,
    );
}

export async function browseCaseSkills(params: {
    limit?: number;
    cursor?: string | null;
} = {}): Promise<CaseSkillListResponse> {
    const query = new URLSearchParams();
    query.set("limit", String(params.limit ?? 30));
    if (params.cursor) query.set("cursor", params.cursor);
    return apiRequest(`/workflows/skills/browse?${query.toString()}`);
}

export async function getCaseSkill(slug: string): Promise<{
    key_source: "user" | "server" | "demo" | "missing";
    skill: CaseSkillDetail;
}> {
    return apiRequest(`/workflows/skills/${encodeURIComponent(slug)}`);
}

export async function listCustomCaseSkills(params: {
    limit?: number;
    cursor?: string | null;
    tag?: string | null;
} = {}): Promise<{
    key_source: "user" | "server" | "demo" | "missing";
    skills: CaseSkillSummary[];
    next_cursor: string | null;
    has_more: boolean;
}> {
    const query = new URLSearchParams();
    query.set("limit", String(params.limit ?? 50));
    if (params.cursor) query.set("cursor", params.cursor);
    if (params.tag) query.set("tag", params.tag);
    return apiRequest(`/workflows/skills/custom?${query.toString()}`);
}

export async function listFavoriteCaseSkills(): Promise<{
    favorites: CaseSkillFavorite[];
}> {
    return apiRequest("/workflows/skills/favorites");
}

export async function favoriteCaseSkill(
    skill: CaseSkillSummary,
): Promise<CaseSkillFavorite> {
    return apiRequest("/workflows/skills/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill }),
    });
}

export async function unfavoriteCaseSkill(slug: string): Promise<void> {
    await apiRequest(`/workflows/skills/favorites/${encodeURIComponent(slug)}`, {
        method: "DELETE",
    });
}

export async function createWorkflowFromCaseSkill(payload: {
    slug: string;
    title?: string;
    practice?: string | null;
    prompt_md?: string | null;
}): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>("/workflows/from-skill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function refreshWorkflowCaseSkill(
    workflowId: string,
): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>(`/workflows/${workflowId}/refresh-skill`, {
        method: "POST",
    });
}

export async function updateWorkflow(
    workflowId: string,
    payload: {
        title?: string;
        prompt_md?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        practice?: string | null;
    },
): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>(`/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function listHiddenWorkflows(): Promise<string[]> {
    return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
    await apiRequest("/workflows/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId }),
    });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
    workflowId: string,
    payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
    await apiRequest<void>(`/workflows/${workflowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowShares(
    workflowId: string,
): Promise<
    {
        id: string;
        shared_with_email: string;
        allow_edit: boolean;
        created_at: string;
    }[]
> {
    return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
    workflowId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
        method: "DELETE",
    });
}
