import type {
    NormalizedToolCall,
    NormalizedToolResult,
    OpenAIToolSchema,
    StreamCallbacks,
} from "./llm/types";

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
    metadata?: Record<string, unknown>;
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

export function caseApiBaseUrl() {
    return (
        process.env.CASE_API_BASE_URL?.replace(/\/+$/, "") ??
        DEFAULT_CASE_API_BASE_URL
    );
}

export class CaseClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;

    constructor(apiKey: string, baseUrl = caseApiBaseUrl()) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }

    private async request<T>(
        path: string,
        init?: RequestInit & { json?: JsonValue },
    ): Promise<T> {
        const { json, headers, ...rest } = init ?? {};
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
            throw new CaseApiError(response.status, body);
        }
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
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

    async listVaults(): Promise<unknown> {
        return this.request<unknown>("/vault");
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

    async downloadVaultObject(vaultId: string, objectId: string): Promise<ArrayBuffer> {
        const response = await fetch(
            `${this.baseUrl}/vault/${encodeURIComponent(vaultId)}/objects/${encodeURIComponent(objectId)}/download`,
            {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    Accept: "application/octet-stream",
                },
            },
        );
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new CaseApiError(response.status, body);
        }
        return response.arrayBuffer();
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

    async searchVault(params: {
        vaultId: string;
        query: string;
        method?: "vector" | "graph" | "hybrid" | "global" | "local" | "fast" | "entity";
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

    async chatCompletion(params: {
        model: string;
        messages: CaseChatMessage[];
        max_tokens?: number;
        temperature?: number;
    }): Promise<{ choices?: { message?: { content?: string | null } }[] }> {
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
        const response = await client.streamChatCompletion({
            model: params.model,
            messages,
            tools: params.tools,
            casemark_show_reasoning: params.enableThinking,
        });
        let content = "";
        const toolCalls = new Map<number, ToolCallAccumulator>();

        for await (const event of readSse(response)) {
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
}): Promise<string> {
    const client = new CaseClient(requireCaseApiKey(params.apiKey));
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
