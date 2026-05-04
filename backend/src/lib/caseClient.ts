import type {
    NormalizedToolCall,
    NormalizedToolResult,
    OpenAIToolSchema,
    StreamCallbacks,
} from "./llm/types";
import {
    commitDemoUsage,
    estimateCaseOperation,
    releaseDemoUsage,
    reserveDemoUsage,
    usageFromResponse,
    type DemoUsageContext,
    type DemoUsageReservation,
} from "./demoUsage";
import { demoEstimateConfig } from "./demoMode";

const DEFAULT_CASE_API_BASE_URL = "https://api.case.dev";

export class CaseApiError extends Error {
    status: number;
    body: string;

    constructor(status: number, body: string, message?: string) {
        super(message ?? `Case.dev API request failed with ${status}`);
        this.status = status;
        this.body = body;
    }
}

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

export type CaseModel = {
    id: string;
    object?: string;
    name?: string;
    description?: string;
    modelType?: string;
    owned_by?: string;
    pricing?: Record<string, unknown>;
    specification?: Record<string, unknown>;
    [key: string]: unknown;
};

export type CaseLlmConfigModel = {
    id: string;
    name: string;
    modelType: string;
    description?: string;
    pricing?: Record<string, unknown>;
    specification?: Record<string, unknown>;
    [key: string]: unknown;
};

export type CaseVaultObject = {
    id: string;
    vaultId?: string;
    filename?: string;
    contentType?: string;
    sizeBytes?: number;
    downloadUrl?: string;
    expiresIn?: number;
    ingestionStatus?: string;
    pageCount?: number;
    textLength?: number;
    chunkCount?: number;
    vectorCount?: number;
    ingestionError?: string | null;
    path?: string | null;
    transcript_object_id?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
};

export type CaseVaultChunk = {
    text: string;
    object_id?: string;
    chunk_index?: number;
    index?: number;
    page_start?: number | null;
    page_end?: number | null;
    word_start_index?: number | null;
    word_end_index?: number | null;
    distance?: number;
    score?: number;
    hybridScore?: number;
    source?: string;
};

export type CaseVaultSearchMethod =
    | "vector"
    | "graph"
    | "hybrid"
    | "global"
    | "local"
    | "fast"
    | "entity";

export type CaseVaultSearchResult = {
    method?: string;
    query?: string;
    response?: string;
    sources?: {
        id?: string;
        filename?: string;
        pageCount?: number;
        textLength?: number;
        chunkCount?: number;
    }[];
    chunks?: CaseVaultChunk[];
    vault_id?: string;
};

export type CaseVaultGraphStats = {
    entities?: number;
    relationships?: number;
    communities?: number;
    documents?: number;
    lastProcessed?: string | null;
    status?: string | null;
};

export type CaseVaultOcrWord = {
    text: string;
    page?: number;
    wordIndex?: number;
    globalWordIndex?: number;
    confidence?: number | null;
    bbox?: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
    } | null;
    [key: string]: unknown;
};

export type CaseVaultOcrWordsResponse = {
    objectId?: string;
    pageCount?: number;
    totalWords?: number;
    pages?: {
        page?: number;
        pageNumber?: number;
        words?: CaseVaultOcrWord[];
        [key: string]: unknown;
    }[];
    createdAt?: string;
};

export type CaseMatter = {
    id: string;
    title?: string;
    display_id?: string | null;
    description?: string | null;
    status?: string | null;
    matter_type?: string | null;
    practice_area?: string | null;
    subtype?: string | null;
    client_name?: string | null;
    responsible_attorney_id?: string | null;
    vault_id?: string | null;
    primary_vault_id?: string | null;
    metadata?: Record<string, unknown> | null;
    custom_fields?: Record<string, unknown> | null;
    created_at?: string;
    updated_at?: string;
    [key: string]: unknown;
};

export type CaseMatterWorkItem = {
    id: string;
    matter_id?: string;
    title?: string;
    description?: string | null;
    type?: string | null;
    status?: string | null;
    priority?: string | null;
    instructions?: string | null;
    due_at?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    metadata?: Record<string, unknown> | null;
    created_at?: string;
    updated_at?: string;
    [key: string]: unknown;
};

export type CaseMatterLogEntry = {
    id: string;
    matter_id?: string;
    event_type?: string;
    summary?: string;
    details?: Record<string, unknown> | null;
    work_item_id?: string | null;
    actor_type?: string | null;
    actor_id?: string | null;
    created_at?: string;
    occurred_at?: string;
    [key: string]: unknown;
};

export type CaseSkillSummary = {
    slug: string;
    name: string;
    summary?: string | null;
    tags?: string[];
    score?: number;
    source?: "curated" | "custom";
    version?: string | number;
    author_name?: string | null;
    license?: string | null;
};

export type CaseSkillDetail = CaseSkillSummary & {
    content: string;
    metadata?: Record<string, unknown> | null;
    bundle?: Record<string, unknown> | null;
};

export type CaseLegalFindParams = {
    query: string;
    jurisdiction?: string;
    numResults?: number;
};

export type CaseLegalDeepResearchParams = CaseLegalFindParams & {
    additionalQueries?: string[];
};

export type CaseLegalFullTextParams = {
    url: string;
    maxCharacters?: number;
    highlightQuery?: string;
    summaryQuery?: string;
};

export type CaseLegalSimilarParams = {
    url: string;
    jurisdiction?: string;
    numResults?: number;
    startPublishedDate?: string;
};

export type CaseLegalCourtsParams = {
    query?: string;
    jurisdiction?: string;
    inUseOnly?: boolean;
    limit?: number;
    offset?: number;
};

export type CaseLegalDocketParams =
    | {
          type: "search";
          query: string;
          court?: string;
          dateFiledAfter?: string;
          dateFiledBefore?: string;
          limit?: number;
          offset?: number;
      }
    | {
          type: "lookup";
          docketId: string;
      };

export type CaseLegalSecFilingParams = {
    type: "search" | "entity";
    query?: string;
    formTypes?: string[];
    ticker?: string;
    entity?: string;
    cik?: string;
    dateAfter?: string;
    dateBefore?: string;
    limit?: number;
    offset?: number;
};

export type CaseLegalPatentSearchParams = {
    query: string;
    applicationStatus?: string;
    applicationType?: string;
    assignee?: string;
    inventor?: string;
    filingDateFrom?: string;
    filingDateTo?: string;
    grantDateFrom?: string;
    grantDateTo?: string;
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
};

export type CaseLegalTrademarkLookupParams = {
    serialNumber?: string;
    registrationNumber?: string;
};

export type CaseLegalResponse = Record<string, unknown>;

export type CaseChatMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    tool_call_id?: string;
    tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }[];
};

type CaseClientOptions = {
    baseUrl?: string;
    usage?: DemoUsageContext;
};

type CaseChatCompletionResponse = {
    choices?: { message?: { content?: string | null } }[];
    usage?: Record<string, unknown>;
};

export function caseApiBaseUrl() {
    return (
        process.env.CASE_API_BASE_URL?.replace(/\/+$/, "") ??
        DEFAULT_CASE_API_BASE_URL
    );
}

export class CaseClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly usage?: DemoUsageContext;

    constructor(apiKey: string, baseUrlOrOptions: string | CaseClientOptions = caseApiBaseUrl()) {
        this.apiKey = apiKey;
        if (typeof baseUrlOrOptions === "string") {
            this.baseUrl = baseUrlOrOptions;
            this.usage = undefined;
        } else {
            this.baseUrl = baseUrlOrOptions.baseUrl ?? caseApiBaseUrl();
            this.usage = baseUrlOrOptions.usage;
        }
    }

    private async request<T>(
        path: string,
        init?: RequestInit & { json?: JsonValue },
    ): Promise<T> {
        const { json, headers, ...rest } = init ?? {};
        const estimate = estimateCaseOperation({
            path,
            method: rest.method,
            json,
            service: this.usage?.service,
            operation: this.usage?.operation,
        });
        let reservation: DemoUsageReservation | null = null;
        try {
            reservation = await reserveDemoUsage({
                context: this.usage,
                service: estimate.service,
                operation: estimate.operation,
                estimateMicros: estimate.estimateMicros,
                model: modelFromJson(json),
                metadata: estimate.metadata,
            });
            const response = await fetch(`${this.baseUrl}${path}`, {
                ...rest,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    Accept: "application/json",
                    ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
                    ...(headers as Record<string, string> | undefined),
                },
                body: json !== undefined ? JSON.stringify(json) : rest.body,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                await releaseDemoUsage(reservation, {
                    metadata: { status: response.status, released_reason: "case_error" },
                });
                throw new CaseApiError(response.status, body);
            }
            if (response.status === 204) {
                await commitDemoUsage(reservation, {
                    model: modelFromJson(json),
                    metadata: { status: response.status },
                });
                return undefined as T;
            }
            const text = await response.text();
            if (!text.trim()) {
                await commitDemoUsage(reservation, {
                    model: modelFromJson(json),
                    metadata: { status: response.status },
                });
                return undefined as T;
            }
            const parsed = JSON.parse(text) as T;
            await commitDemoUsage(reservation, {
                model: modelFromJson(json),
                usage: usageFromResponse(parsed),
                metadata: { status: response.status },
            });
            return parsed;
        } catch (err) {
            if (!(err instanceof CaseApiError)) {
                await releaseDemoUsage(reservation, {
                    chargeEstimate: false,
                    metadata: { released_reason: "request_failure" },
                });
            }
            throw err;
        }
    }

    async listModels(): Promise<CaseModel[]> {
        const data = await this.request<{ data?: CaseModel[]; models?: CaseModel[] }>(
            "/llm/v1/models",
        );
        return data.data ?? data.models ?? [];
    }

    async getLlmConfig(): Promise<{ models: CaseLlmConfigModel[] }> {
        return this.request<{ models: CaseLlmConfigModel[] }>("/llm/config");
    }

    async listVaults(): Promise<{ vaults?: unknown[]; data?: unknown[] } | unknown[]> {
        return this.request("/vault");
    }

    async searchSkills(params: {
        query: string;
        limit?: number;
    }): Promise<{ results: CaseSkillSummary[]; methods_used?: string[] }> {
        const query = new URLSearchParams({
            q: params.query,
            limit: String(params.limit ?? 10),
        });
        return this.request(`/skills/resolve?${query.toString()}`);
    }

    async listSkills(params: {
        limit?: number;
        cursor?: string | null;
    } = {}): Promise<
        | {
            skills?: CaseSkillSummary[];
            results?: CaseSkillSummary[];
            data?: CaseSkillSummary[];
            next_cursor?: string | null;
            nextCursor?: string | null;
            has_more?: boolean;
            hasMore?: boolean;
        }
        | CaseSkillSummary[]
    > {
        const query = new URLSearchParams();
        query.set("limit", String(params.limit ?? 30));
        if (params.cursor) query.set("cursor", params.cursor);
        return this.request(`/skills?${query.toString()}`);
    }

    async readSkill(slug: string): Promise<CaseSkillDetail> {
        return this.request<CaseSkillDetail>(
            `/skills/${encodeURIComponent(slug)}`,
        );
    }

    async listCustomSkills(params: {
        limit?: number;
        cursor?: string | null;
        tag?: string | null;
    } = {}): Promise<{
        skills: CaseSkillSummary[];
        next_cursor?: string | null;
        has_more?: boolean;
    }> {
        const query = new URLSearchParams();
        query.set("limit", String(params.limit ?? 50));
        if (params.cursor) query.set("cursor", params.cursor);
        if (params.tag) query.set("tag", params.tag);
        return this.request(`/skills/custom?${query.toString()}`);
    }

    async createCustomSkill(params: {
        name: string;
        slug?: string;
        summary?: string | null;
        content: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
    }): Promise<CaseSkillDetail> {
        return this.request<CaseSkillDetail>("/skills", {
            method: "POST",
            json: params,
        });
    }

    async updateCustomSkill(
        slug: string,
        params: {
            name?: string;
            slug?: string;
            summary?: string | null;
            content?: string;
            tags?: string[];
            metadata?: Record<string, unknown>;
        },
    ): Promise<CaseSkillDetail> {
        return this.request<CaseSkillDetail>(
            `/skills/${encodeURIComponent(slug)}`,
            {
                method: "PUT",
                json: params,
            },
        );
    }

    async legalFind(params: CaseLegalFindParams): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/find", {
            method: "POST",
            json: params,
        });
    }

    async legalDeepResearch(
        params: CaseLegalDeepResearchParams,
    ): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/research", {
            method: "POST",
            json: params,
        });
    }

    async legalFullText(
        params: CaseLegalFullTextParams,
    ): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/full-text", {
            method: "POST",
            json: params,
        });
    }

    async legalFindSimilar(
        params: CaseLegalSimilarParams,
    ): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/similar", {
            method: "POST",
            json: params,
        });
    }

    async legalExtractCitations(text: string): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/citations", {
            method: "POST",
            json: { text },
        });
    }

    async legalExtractCitationsFromUrl(url: string): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/citations-from-url", {
            method: "POST",
            json: { url },
        });
    }

    async legalVerifyCitations(text: string): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/verify", {
            method: "POST",
            json: { text },
        });
    }

    async legalResolveJurisdiction(name: string): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/jurisdictions", {
            method: "POST",
            json: { name },
        });
    }

    async legalListCourts(
        params: CaseLegalCourtsParams = {},
    ): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/courts", {
            method: "POST",
            json: params,
        });
    }

    async legalDocket(params: CaseLegalDocketParams): Promise<CaseLegalResponse> {
        const json =
            params.type === "lookup"
                ? {
                      type: "lookup",
                      docketId: params.docketId,
                      live: false,
                  }
                : {
                      type: "search",
                      query: params.query,
                      court: params.court,
                      dateFiledAfter: params.dateFiledAfter,
                      dateFiledBefore: params.dateFiledBefore,
                      limit: params.limit,
                      offset: params.offset,
                  };
        return this.request<CaseLegalResponse>("/legal/v1/docket", {
            method: "POST",
            json,
        });
    }

    async legalSecFiling(
        params: CaseLegalSecFilingParams,
    ): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/sec-filing", {
            method: "POST",
            json: params,
        });
    }

    async legalPatentSearch(
        params: CaseLegalPatentSearchParams,
    ): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/patent-search", {
            method: "POST",
            json: params,
        });
    }

    async legalTrademarkLookup(
        params: CaseLegalTrademarkLookupParams,
    ): Promise<CaseLegalResponse> {
        return this.request<CaseLegalResponse>("/legal/v1/trademark-search", {
            method: "POST",
            json: params,
        });
    }

    async createVault(params: {
        name: string;
        description?: string;
        metadata?: Record<string, unknown>;
        enableGraph?: boolean;
        enableIndexing?: boolean;
    }): Promise<{ id: string; name?: string }> {
        return this.request<{ id: string; name?: string }>("/vault", {
            method: "POST",
            json: params,
        });
    }

    async createVaultUpload(params: {
        vaultId: string;
        filename: string;
        contentType: string;
        sizeBytes?: number;
        metadata?: Record<string, unknown>;
        path?: string | null;
        auto_index?: boolean;
    }): Promise<{
        objectId: string;
        uploadUrl: string;
        expiresIn?: number;
        s3Key?: string;
    }> {
        return this.request(`/vault/${encodeURIComponent(params.vaultId)}/upload`, {
            method: "POST",
            json: {
                filename: params.filename,
                contentType: params.contentType,
                sizeBytes: params.sizeBytes,
                metadata: params.metadata,
                path: params.path ?? undefined,
                auto_index: params.auto_index ?? true,
            },
        });
    }

    async uploadToPresignedUrl(
        uploadUrl: string,
        bytes: ArrayBuffer | Buffer,
        contentType: string,
    ): Promise<{ etag?: string | null }> {
        const body =
            bytes instanceof Buffer
                ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                : new Uint8Array(bytes);
        const response = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": contentType },
            body: body as unknown as BodyInit,
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new CaseApiError(response.status, body, "Case.dev vault upload failed");
        }
        return { etag: response.headers.get("etag") };
    }

    async confirmVaultUpload(params: {
        vaultId: string;
        objectId: string;
        success: true;
        sizeBytes: number;
        etag?: string | null;
    }): Promise<unknown> {
        return this.request(
            `/vault/${encodeURIComponent(params.vaultId)}/upload/${encodeURIComponent(params.objectId)}/confirm`,
            {
                method: "POST",
                json: {
                    success: true,
                    sizeBytes: params.sizeBytes,
                    etag: params.etag ?? undefined,
                },
            },
        );
    }

    async ingestVaultObject(vaultId: string, objectId: string): Promise<unknown> {
        return this.request(
            `/vault/${encodeURIComponent(vaultId)}/ingest/${encodeURIComponent(objectId)}`,
            { method: "POST" },
        );
    }

    async getVaultObject(vaultId: string, objectId: string): Promise<CaseVaultObject> {
        return this.request<CaseVaultObject>(
            `/vault/${encodeURIComponent(vaultId)}/objects/${encodeURIComponent(objectId)}`,
        );
    }

    async listVaultObjects(params: {
        vaultId: string;
        limit?: number;
        cursor?: string | null;
    }): Promise<{
        objects?: CaseVaultObject[];
        data?: CaseVaultObject[];
        hasMore?: boolean;
        nextCursor?: string | null;
    }> {
        const query = new URLSearchParams();
        if (typeof params.limit === "number") query.set("limit", String(params.limit));
        if (params.cursor) query.set("cursor", params.cursor);
        const suffix = query.toString() ? `?${query}` : "";
        return this.request(
            `/vault/${encodeURIComponent(params.vaultId)}/objects${suffix}`,
        );
    }

    async updateVaultObject(params: {
        vaultId: string;
        objectId: string;
        filename?: string;
        path?: string | null;
        metadata?: Record<string, unknown>;
    }): Promise<CaseVaultObject> {
        return this.request<CaseVaultObject>(
            `/vault/${encodeURIComponent(params.vaultId)}/objects/${encodeURIComponent(params.objectId)}`,
            {
                method: "PATCH",
                json: {
                    filename: params.filename,
                    path: params.path,
                    metadata: params.metadata,
                },
            },
        );
    }

    async downloadVaultObject(vaultId: string, objectId: string): Promise<ArrayBuffer> {
        const path = `/vault/${encodeURIComponent(vaultId)}/objects/${encodeURIComponent(objectId)}/download`;
        const estimate = estimateCaseOperation({
            path,
            method: "GET",
            service: this.usage?.service,
            operation: this.usage?.operation,
        });
        let reservation: DemoUsageReservation | null = null;
        try {
            reservation = await reserveDemoUsage({
                context: this.usage,
                service: estimate.service,
                operation: estimate.operation,
                estimateMicros: estimate.estimateMicros,
                metadata: estimate.metadata,
            });
            const response = await fetch(`${this.baseUrl}${path}`, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    Accept: "application/octet-stream",
                },
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                await releaseDemoUsage(reservation, {
                    metadata: { status: response.status, released_reason: "case_error" },
                });
                throw new CaseApiError(response.status, body);
            }
            const body = await response.arrayBuffer();
            await commitDemoUsage(reservation, {
                metadata: { status: response.status, bytes: body.byteLength },
            });
            return body;
        } catch (err) {
            if (!(err instanceof CaseApiError)) {
                await releaseDemoUsage(reservation, {
                    metadata: { released_reason: "download_failure" },
                });
            }
            throw err;
        }
    }

    async createVaultObjectPresignedUrl(params: {
        vaultId: string;
        objectId: string;
        operation?: "GET" | "PUT" | "DELETE" | "HEAD";
        expiresIn?: number;
        contentType?: string;
        sizeBytes?: number;
    }): Promise<{
        objectId: string;
        vaultId: string;
        filename?: string;
        s3Key?: string;
        operation: string;
        presignedUrl: string;
        expiresIn: number;
        expiresAt?: string;
        instructions?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
    }> {
        return this.request(
            `/vault/${encodeURIComponent(params.vaultId)}/objects/${encodeURIComponent(params.objectId)}/presigned-url`,
            {
                method: "POST",
                json: {
                    operation: params.operation ?? "GET",
                    expiresIn: params.expiresIn ?? 3600,
                    contentType: params.contentType,
                    sizeBytes: params.sizeBytes,
                },
            },
        );
    }

    async deleteVaultObject(vaultId: string, objectId: string): Promise<unknown> {
        return this.request(
            `/vault/${encodeURIComponent(vaultId)}/objects/${encodeURIComponent(objectId)}`,
            { method: "DELETE" },
        );
    }

    async getVaultObjectText(
        vaultId: string,
        objectId: string,
    ): Promise<{ text: string; metadata?: Record<string, unknown> }> {
        return this.request(
            `/vault/${encodeURIComponent(vaultId)}/objects/${encodeURIComponent(objectId)}/text`,
        );
    }

    async getVaultObjectChunks(params: {
        vaultId: string;
        objectId: string;
        start?: number;
        end?: number;
    }): Promise<{ chunks: CaseVaultChunk[]; total_chunks?: number }> {
        const query = new URLSearchParams();
        if (typeof params.start === "number") query.set("start", String(params.start));
        if (typeof params.end === "number") query.set("end", String(params.end));
        const suffix = query.toString() ? `?${query}` : "";
        return this.request(
            `/vault/${encodeURIComponent(params.vaultId)}/objects/${encodeURIComponent(params.objectId)}/chunks${suffix}`,
        );
    }

    async getVaultObjectOcrWords(
        vaultId: string,
        objectId: string,
    ): Promise<CaseVaultOcrWordsResponse> {
        return this.request<CaseVaultOcrWordsResponse>(
            `/vault/${encodeURIComponent(vaultId)}/objects/${encodeURIComponent(objectId)}/ocr-words`,
        );
    }

    async searchVault(params: {
        vaultId: string;
        query: string;
        method?: CaseVaultSearchMethod;
        topK?: number;
        filters?: Record<string, unknown>;
    }): Promise<CaseVaultSearchResult> {
        return this.request(`/vault/${encodeURIComponent(params.vaultId)}/search`, {
            method: "POST",
            json: {
                query: params.query,
                method: params.method ?? "hybrid",
                topK: params.topK ?? 10,
                filters: params.filters,
            },
        });
    }

    async initializeVaultGraphRag(vaultId: string): Promise<{
        success?: boolean;
        vault_id?: string;
        status?: string;
        message?: string;
    }> {
        return this.request(`/vault/${encodeURIComponent(vaultId)}/graphrag/init`, {
            method: "POST",
        });
    }

    async getVaultGraphRagStats(vaultId: string): Promise<CaseVaultGraphStats> {
        return this.request<CaseVaultGraphStats>(
            `/vault/${encodeURIComponent(vaultId)}/graphrag/stats`,
        );
    }

    async indexVaultObjectInGraphRag(
        vaultId: string,
        objectId: string,
    ): Promise<unknown> {
        return this.request(
            `/vault/${encodeURIComponent(vaultId)}/graphrag/${encodeURIComponent(objectId)}`,
            { method: "POST" },
        );
    }

    async listVaultMemory(vaultId: string): Promise<unknown> {
        return this.request(`/vault/${encodeURIComponent(vaultId)}/memory`);
    }

    async searchVaultMemory(params: {
        vaultId: string;
        query: string;
        types?: string[];
        tags?: string[];
        limit?: number;
    }): Promise<unknown> {
        return this.request(`/vault/${encodeURIComponent(params.vaultId)}/memory/search`, {
            method: "POST",
            json: {
                query: params.query,
                types: params.types,
                tags: params.tags,
                limit: params.limit,
            },
        });
    }

    async createVaultWebhookSubscription(params: {
        vaultId: string;
        callbackUrl: string;
        eventTypes: string[];
        objectIds?: string[];
        signingSecret?: string;
    }): Promise<unknown> {
        return this.request(
            `/vault/${encodeURIComponent(params.vaultId)}/events/subscriptions`,
            {
                method: "POST",
                json: {
                    callbackUrl: params.callbackUrl,
                    eventTypes: params.eventTypes,
                    objectIds: params.objectIds,
                    signingSecret: params.signingSecret,
                },
            },
        );
    }

    async listVaultWebhookSubscriptions(vaultId: string): Promise<unknown> {
        return this.request(
            `/vault/${encodeURIComponent(vaultId)}/events/subscriptions`,
        );
    }

    async createMatter(params: {
        title: string;
        display_id?: string | null;
        description?: string | null;
        status?: string;
        matter_type?: string | null;
        practice_area?: string | null;
        subtype?: string | null;
        client_name?: string | null;
        responsible_attorney_id?: string | null;
        metadata?: Record<string, unknown>;
        custom_fields?: Record<string, unknown>;
        vault_id?: string | null;
        vault?: Record<string, unknown>;
    }): Promise<CaseMatter> {
        return this.request<CaseMatter>("/matters/v1", {
            method: "POST",
            json: params,
        });
    }

    async listMatters(params: {
        limit?: number;
        cursor?: string | null;
        status?: string | null;
    } = {}): Promise<{ matters?: CaseMatter[]; data?: CaseMatter[] } | CaseMatter[]> {
        const query = new URLSearchParams();
        if (typeof params.limit === "number") query.set("limit", String(params.limit));
        if (params.cursor) query.set("cursor", params.cursor);
        if (params.status) query.set("status", params.status);
        const suffix = query.toString() ? `?${query}` : "";
        return this.request(`/matters/v1${suffix}`);
    }

    async getMatter(id: string): Promise<CaseMatter> {
        return this.request<CaseMatter>(`/matters/v1/${encodeURIComponent(id)}`);
    }

    async updateMatter(
        id: string,
        params: Partial<{
            title: string;
            display_id: string | null;
            description: string | null;
            status: string;
            matter_type: string | null;
            practice_area: string | null;
            subtype: string | null;
            client_name: string | null;
            responsible_attorney_id: string | null;
            important_dates: Record<string, unknown>;
            billing: Record<string, unknown>;
            metadata: Record<string, unknown>;
            custom_fields: Record<string, unknown>;
            archived_at: string | null;
        }>,
    ): Promise<CaseMatter> {
        return this.request<CaseMatter>(`/matters/v1/${encodeURIComponent(id)}`, {
            method: "PATCH",
            json: params as Record<string, unknown>,
        });
    }

    async listMatterLogEntries(id: string): Promise<{
        entries?: CaseMatterLogEntry[];
        logs?: CaseMatterLogEntry[];
        data?: CaseMatterLogEntry[];
    }> {
        return this.request(`/matters/v1/${encodeURIComponent(id)}/log`);
    }

    async createMatterLogEntry(
        id: string,
        params: {
            event_type: string;
            summary: string;
            details?: Record<string, unknown>;
            work_item_id?: string | null;
        },
    ): Promise<CaseMatterLogEntry> {
        return this.request<CaseMatterLogEntry>(
            `/matters/v1/${encodeURIComponent(id)}/log`,
            {
                method: "POST",
                json: params,
            },
        );
    }

    async exportMatterLogEntries(
        id: string,
        params: Record<string, unknown>,
    ): Promise<unknown> {
        return this.request(`/matters/v1/${encodeURIComponent(id)}/log/export`, {
            method: "POST",
            json: params,
        });
    }

    async listMatterParties(id: string): Promise<unknown> {
        return this.request(`/matters/v1/${encodeURIComponent(id)}/parties`);
    }

    async listMatterShares(id: string): Promise<unknown> {
        return this.request(`/matters/v1/${encodeURIComponent(id)}/shares`);
    }

    async listMatterWorkItems(id: string): Promise<{
        work_items?: CaseMatterWorkItem[];
        items?: CaseMatterWorkItem[];
        data?: CaseMatterWorkItem[];
    }> {
        return this.request(`/matters/v1/${encodeURIComponent(id)}/work-items`);
    }

    async createMatterWorkItem(
        id: string,
        params: {
            title: string;
            description?: string | null;
            type?: string;
            priority?: string;
            assignee_id?: string | null;
            instructions?: string | null;
            exit_criteria?: string[];
            metadata?: Record<string, unknown>;
            due_at?: string | null;
        },
    ): Promise<CaseMatterWorkItem> {
        return this.request<CaseMatterWorkItem>(
            `/matters/v1/${encodeURIComponent(id)}/work-items`,
            {
                method: "POST",
                json: params,
            },
        );
    }

    async getMatterWorkItem(
        id: string,
        workItemId: string,
    ): Promise<CaseMatterWorkItem> {
        return this.request<CaseMatterWorkItem>(
            `/matters/v1/${encodeURIComponent(id)}/work-items/${encodeURIComponent(workItemId)}`,
        );
    }

    async updateMatterWorkItem(
        id: string,
        workItemId: string,
        params: Partial<CaseMatterWorkItem>,
    ): Promise<CaseMatterWorkItem> {
        return this.request<CaseMatterWorkItem>(
            `/matters/v1/${encodeURIComponent(id)}/work-items/${encodeURIComponent(workItemId)}`,
            {
                method: "PATCH",
                json: params as Record<string, unknown>,
            },
        );
    }

    async decideMatterWorkItem(
        id: string,
        workItemId: string,
        params: {
            decision: "approve" | "revise" | "block" | "reassign";
            reason?: string | null;
            agent_type_id?: string | null;
            metadata?: Record<string, unknown>;
        },
    ): Promise<CaseMatterWorkItem | unknown> {
        return this.request(
            `/matters/v1/${encodeURIComponent(id)}/work-items/${encodeURIComponent(workItemId)}/decision`,
            {
                method: "POST",
                json: params,
            },
        );
    }

    async listMatterWorkItemExecutions(
        id: string,
        workItemId: string,
    ): Promise<unknown> {
        return this.request(
            `/matters/v1/${encodeURIComponent(id)}/work-items/${encodeURIComponent(workItemId)}/executions`,
        );
    }

    async chatCompletion(params: {
        model: string;
        messages: CaseChatMessage[];
        max_tokens?: number;
        temperature?: number;
    }): Promise<CaseChatCompletionResponse> {
        return this.request("/llm/v1/chat/completions", {
            method: "POST",
            json: {
                model: params.model,
                messages: params.messages,
                max_tokens: params.max_tokens,
                temperature: params.temperature,
            },
        });
    }

    async streamChatCompletion(params: {
        model: string;
        messages: CaseChatMessage[];
        tools?: OpenAIToolSchema[];
        max_tokens?: number;
        temperature?: number;
        casemark_show_reasoning?: boolean;
    }): Promise<Response> {
        const response = await fetch(`${this.baseUrl}/llm/v1/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
            },
            body: JSON.stringify({
                model: params.model,
                messages: params.messages,
                tools: params.tools?.length ? params.tools : undefined,
                tool_choice: params.tools?.length ? "auto" : undefined,
                stream: true,
                max_tokens: params.max_tokens,
                temperature: params.temperature,
                casemark_show_reasoning: params.casemark_show_reasoning,
            }),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new CaseApiError(response.status, body);
        }
        return response;
    }
}

function requireCaseApiKey(apiKey?: string | null): string {
    const trimmed = apiKey?.trim();
    if (!trimmed) {
        throw new Error("A Case.dev API key is required. Add one in Account > Models.");
    }
    return trimmed;
}

async function* readSse(response: Response): AsyncGenerator<Record<string, unknown>> {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = rawEvent
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("\n");
            if (!data || data === "[DONE]") continue;
            try {
                yield JSON.parse(data) as Record<string, unknown>;
            } catch {
                continue;
            }
        }
    }
}

type ToolCallAccumulator = {
    id?: string;
    name?: string;
    arguments: string;
};

function normalizeToolCalls(
    toolCalls: Map<number, ToolCallAccumulator>,
): NormalizedToolCall[] {
    return [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
            id: call.id ?? `case-tool-${index}`,
            name: call.name ?? "",
            input: safeJsonObject(call.arguments),
        }))
        .filter((call) => call.name);
}

function safeJsonObject(raw: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(raw || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

export async function streamCaseChat(params: {
    model: string;
    systemPrompt: string;
    messages: { role: "user" | "assistant"; content: string }[];
    tools?: OpenAIToolSchema[];
    maxIterations?: number;
    callbacks?: StreamCallbacks;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKey?: string | null;
    enableThinking?: boolean;
    usageContext?: DemoUsageContext;
}): Promise<{ fullText: string }> {
    const client = new CaseClient(requireCaseApiKey(params.apiKey));
    const messages: CaseChatMessage[] = [
        ...(params.systemPrompt
            ? [{ role: "system" as const, content: params.systemPrompt }]
            : []),
        ...params.messages.map((m) => ({
            role: m.role,
            content: m.content,
        })),
    ];
    const maxIterations = params.maxIterations ?? 8;
    let fullText = "";

    for (let iteration = 0; iteration < maxIterations; iteration++) {
        const reservation = await reserveDemoUsage({
            context: params.usageContext,
            service: "llm",
            operation: "llm.chat_stream",
            estimateMicros: demoEstimateConfig().llmReserveMicros,
            model: params.model,
            metadata: { iteration, message_count: messages.length },
        });
        let latestUsage: Record<string, unknown> | null = null;
        let response: Response;
        try {
            response = await client.streamChatCompletion({
                model: params.model,
                messages,
                tools: params.tools,
                casemark_show_reasoning: params.enableThinking,
            });
        } catch (err) {
            await releaseDemoUsage(reservation, {
                metadata: { released_reason: "stream_open_failure" },
            });
            throw err;
        }
        let content = "";
        const toolCalls = new Map<number, ToolCallAccumulator>();

        try {
            for await (const event of readSse(response)) {
                if (
                    event.usage &&
                    typeof event.usage === "object" &&
                    !Array.isArray(event.usage)
                ) {
                    latestUsage = event.usage as Record<string, unknown>;
                }
                const choice = Array.isArray(event.choices)
                    ? (event.choices[0] as Record<string, unknown> | undefined)
                    : undefined;
                if (!choice) continue;
                const delta = choice.delta as Record<string, unknown> | undefined;
                if (!delta) continue;

                const contentDelta =
                    typeof delta.content === "string" ? delta.content : "";
                if (contentDelta) {
                    content += contentDelta;
                    fullText += contentDelta;
                    params.callbacks?.onContentDelta?.(contentDelta);
                }

                const reasoningDelta =
                    typeof delta.reasoning === "string"
                        ? delta.reasoning
                        : typeof delta.reasoning_content === "string"
                          ? delta.reasoning_content
                          : "";
                if (reasoningDelta) {
                    params.callbacks?.onReasoningDelta?.(reasoningDelta);
                }

                if (Array.isArray(delta.tool_calls)) {
                    for (const raw of delta.tool_calls as Record<string, unknown>[]) {
                        const index =
                            typeof raw.index === "number" ? raw.index : toolCalls.size;
                        const current =
                            toolCalls.get(index) ?? { arguments: "" };
                        if (typeof raw.id === "string") current.id = raw.id;
                        const fn = raw.function as Record<string, unknown> | undefined;
                        if (fn) {
                            if (typeof fn.name === "string") current.name = fn.name;
                            if (typeof fn.arguments === "string") {
                                current.arguments += fn.arguments;
                            }
                        }
                        toolCalls.set(index, current);
                    }
                }
            }
            await commitDemoUsage(reservation, {
                model: params.model,
                usage: latestUsage,
                units: { output_characters: content.length },
                metadata: { iteration, tool_call_count: toolCalls.size },
            });
        } catch (err) {
            await releaseDemoUsage(reservation, {
                chargeEstimate: true,
                metadata: { released_reason: "stream_read_failure" },
            });
            throw err;
        }

        const calls = normalizeToolCalls(toolCalls);
        if (!calls.length) {
            if (params.callbacks?.onReasoningBlockEnd) {
                params.callbacks.onReasoningBlockEnd();
            }
            break;
        }

        for (const call of calls) params.callbacks?.onToolCallStart?.(call);
        messages.push({
            role: "assistant",
            content: content || null,
            tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                    name: call.name,
                    arguments: JSON.stringify(call.input),
                },
            })),
        });
        const results = params.runTools ? await params.runTools(calls) : [];
        for (const result of results) {
            messages.push({
                role: "tool",
                tool_call_id: result.tool_use_id,
                content: result.content,
            });
        }
    }

    return { fullText };
}

export async function completeCaseText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKey?: string | null;
    usageContext?: DemoUsageContext;
}): Promise<string> {
    const client = new CaseClient(requireCaseApiKey(params.apiKey), {
        usage: params.usageContext,
    });
    const messages: CaseChatMessage[] = [
        ...(params.systemPrompt
            ? [{ role: "system" as const, content: params.systemPrompt }]
            : []),
        { role: "user", content: params.user },
    ];
    const response = await client.chatCompletion({
        model: params.model,
        messages,
        max_tokens: params.maxTokens,
        temperature: 0,
    });
    return response.choices?.[0]?.message?.content?.trim() ?? "";
}

function modelFromJson(json: unknown): string | null {
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const model = (json as Record<string, unknown>).model;
    return typeof model === "string" ? model : null;
}
