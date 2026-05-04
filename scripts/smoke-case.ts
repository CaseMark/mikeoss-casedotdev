import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CaseClient } from "../backend/src/lib/caseClient";
import { createServerDb } from "../backend/src/lib/db";

type JsonRecord = Record<string, unknown>;

type SmokeDocument = {
    id: string;
    filename: string;
    current_version_id?: string | null;
    status?: string | null;
};

type SmokeMatter = {
    id: string;
    name: string;
    case_matter_id?: string | null;
};

type Step = {
    name: string;
    status: "pass" | "fail" | "skip";
    detail: string;
};

type DocumentReadiness = {
    documentId: string;
    filename: string;
    documentStatus: string | null;
    currentVersionId: string | null;
    storagePath: string | null;
    syncStatus: string | null;
    ingestionStatus: string | null;
    caseVaultId: string | null;
    caseObjectId: string | null;
    pageCount: number | null;
    textLength: number | null;
    chunkCount: number | null;
    vectorCount: number | null;
    error: string | null;
    ready: boolean;
};

type ChatSmokeResult = {
    chatId: string | null;
    content: string;
    events: JsonRecord[];
    toolNames: string[];
    citations: JsonRecord[];
    docsCreated: JsonRecord[];
    errors: string[];
};

const scriptDir = path.dirname(path.resolve(process.argv[1] ?? "scripts/smoke-case.ts"));
const rootDir = path.resolve(scriptDir, "..");
const fsp = fs.promises;

function loadEnvFile(filePath: string) {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!key || process.env[key] != null) continue;
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }
}

loadEnvFile(path.join(rootDir, "backend/.env"));

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const backendUrl =
    process.env.MIKE_SMOKE_BACKEND_URL?.replace(/\/$/, "") ??
    `http://localhost:${process.env.BACKEND_PORT ?? "3001"}`;
const frontendUrl =
    process.env.MIKE_SMOKE_FRONTEND_URL?.replace(/\/$/, "") ??
    `http://localhost:${process.env.FRONTEND_PORT ?? "3000"}`;
const docsDir =
    process.env.MIKE_SMOKE_DOC_DIR ?? path.join(rootDir, ".mike-dev", "smoke-docs");
const timeoutMs = Number(process.env.MIKE_SMOKE_TIMEOUT_MS ?? 900_000);
const pollMs = Number(process.env.MIKE_SMOKE_POLL_MS ?? 5_000);
const requiredDocs = ["Med-sample.pdf", "ilya.pdf", "nadeau.pdf"];
const steps: Step[] = [];

function usage() {
    console.log(`Usage: npx tsx scripts/smoke-case.ts [--dry-run]

Runs the Mike Case.dev smoke flow using MIKE_SMOKE_CASE_API_KEY from the shell.
The key is never printed or stored by this script.`);
}

if (args.has("-h") || args.has("--help")) {
    usage();
    process.exit(0);
}

function printStep(status: Step["status"], name: string, detail: string) {
    steps.push({ status, name, detail });
    const label = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
    console.log(`[${label}] ${name}: ${detail}`);
}

function truncate(value: string, max = 700) {
    return value.length > max ? `${value.slice(0, max)}...` : value;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is JsonRecord {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function randomSuffix() {
    return crypto.randomBytes(5).toString("hex");
}

function jsonHeaders() {
    return {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: frontendUrl,
    };
}

class CookieJar {
    private cookies = new Map<string, string>();

    apply(headers: Headers) {
        if (!this.cookies.size) return;
        headers.set(
            "Cookie",
            [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
        );
    }

    capture(headers: Headers) {
        const withGetSetCookie = headers as Headers & {
            getSetCookie?: () => string[];
        };
        const rawHeaders =
            withGetSetCookie.getSetCookie?.() ??
            (headers.get("set-cookie")
                ? headers.get("set-cookie")!.split(/,(?=\s*[^;,\s]+=)/)
                : []);
        for (const raw of rawHeaders) {
            const pair = raw.split(";")[0]?.trim();
            if (!pair) continue;
            const eq = pair.indexOf("=");
            if (eq <= 0) continue;
            this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
        }
    }

    hasCookies() {
        return this.cookies.size > 0;
    }
}

const jar = new CookieJar();

async function requestJson<T>(
    route: string,
    init: RequestInit = {},
): Promise<T> {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (!headers.has("Origin")) headers.set("Origin", frontendUrl);
    jar.apply(headers);
    const response = await fetch(`${backendUrl}${route}`, {
        ...init,
        headers,
        redirect: "manual",
    });
    jar.capture(response.headers);
    const text = await response.text();
    if (!response.ok) {
        throw new Error(
            `${init.method ?? "GET"} ${route} failed with ${response.status}: ${truncate(text)}`,
        );
    }
    if (!text.trim()) return undefined as T;
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`${route} returned non-JSON response: ${truncate(text)}`);
    }
}

async function requestBytes(routeOrUrl: string): Promise<ArrayBuffer> {
    const headers = new Headers({ Origin: frontendUrl });
    jar.apply(headers);
    const url = routeOrUrl.startsWith("http")
        ? routeOrUrl
        : `${backendUrl}${routeOrUrl.startsWith("/") ? routeOrUrl : `/${routeOrUrl}`}`;
    const response = await fetch(url, { headers, redirect: "manual" });
    jar.capture(response.headers);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`GET ${routeOrUrl} failed with ${response.status}: ${truncate(text)}`);
    }
    return response.arrayBuffer();
}

async function ensureFixtureDocs() {
    for (const doc of requiredDocs) {
        const filePath = path.join(docsDir, doc);
        const stat = await fsp.stat(filePath).catch(() => null);
        if (!stat?.isFile()) throw new Error(`Missing fixture ${filePath}`);
    }
    printStep("pass", "fixtures", `${requiredDocs.length} PDFs found in ${docsDir}`);
}

async function healthCheck() {
    const health = await fetch(`${backendUrl}/health`);
    if (!health.ok) throw new Error(`Backend health failed: ${health.status}`);
    const app = await fetch(frontendUrl);
    if (!app.ok) throw new Error(`Frontend check failed: ${app.status}`);
    printStep("pass", "services", `backend ${backendUrl}, frontend ${frontendUrl}`);
}

async function createSmokeUser(timestamp: string) {
    const email = `smoke+${timestamp}-${randomSuffix()}@case.dev`;
    const password = `Smoke-${randomSuffix()}-${randomSuffix()}`;
    const name = `Smoke User ${timestamp}`;

    await requestJson("/api/auth/sign-up/email", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ email, password, name }),
    });

    if (!jar.hasCookies()) {
        await requestJson("/api/auth/sign-in/email", {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({ email, password }),
        });
    }

    const session = await requestJson<JsonRecord>("/api/auth/get-session");
    if (!isRecord(session) || !session.user) {
        throw new Error("Better Auth did not return a session after signup.");
    }

    await requestJson("/user/profile", { method: "POST", headers: jsonHeaders() });
    await requestJson("/user/profile", {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({
            display_name: name,
            organisation: "Case.dev Mike smoke",
        }),
    });

    printStep("pass", "auth", `created disposable user ${email}`);
    return { email, password, name };
}

async function saveCaseKey() {
    const apiKey = process.env.MIKE_SMOKE_CASE_API_KEY?.trim();
    if (!apiKey) throw new Error("MIKE_SMOKE_CASE_API_KEY is required.");
    const status = await requestJson<JsonRecord>("/user/case-api-key", {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({ api_key: apiKey }),
    });
    const capabilities = isRecord(status.capabilities)
        ? (status.capabilities as Record<string, unknown>)
        : {};
    const missing = ["llm", "vault", "skills", "matters", "legal"].filter(
        (cap) => capabilities[cap] !== true,
    );
    if (status.status !== "verified" || missing.length) {
        throw new Error(
            `Case key was not fully ready. status=${String(status.status)} missing=${missing.join(",") || "none"}`,
        );
    }
    printStep(
        "pass",
        "case key",
        `verified capabilities: llm, vault, skills, matters, legal; models=${String(capabilities.model_count ?? "unknown")}`,
    );
}

async function createMatter(timestamp: string): Promise<SmokeMatter> {
    const matter = await requestJson<SmokeMatter>("/matters", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
            name: `SMOKE Depo Medical ${timestamp}`,
            cm_number: `SMOKE-${timestamp}`,
            practice_area: "Personal injury",
            matter_type: "Deposition and medical smoke test",
            client_name: "Smoke Client",
        }),
    });
    if (!matter.id) throw new Error("Matter response did not include an id.");
    printStep(
        "pass",
        "matter",
        `created ${matter.name} (${matter.id})${matter.case_matter_id ? ` linked to Case matter ${matter.case_matter_id}` : ""}`,
    );
    return matter;
}

async function uploadMatterDocument(matterId: string, filename: string) {
    const filePath = path.join(docsDir, filename);
    const bytes = await fsp.readFile(filePath);
    const form = new FormData();
    form.append(
        "file",
        new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }),
        filename,
    );
    const headers = new Headers({ Accept: "application/json", Origin: frontendUrl });
    jar.apply(headers);
    const response = await fetch(
        `${backendUrl}/matters/${encodeURIComponent(matterId)}/documents`,
        {
            method: "POST",
            headers,
            body: form,
        },
    );
    jar.capture(response.headers);
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Upload ${filename} failed with ${response.status}: ${truncate(text)}`);
    }
    const doc = JSON.parse(text) as SmokeDocument;
    if (!doc.id) throw new Error(`Upload ${filename} returned no document id.`);
    return doc;
}

async function uploadDocuments(matterId: string) {
    const uploaded: SmokeDocument[] = [];
    for (const filename of requiredDocs) {
        const doc = await uploadMatterDocument(matterId, filename);
        uploaded.push(doc);
        console.log(`[smoke] uploaded ${filename} as ${doc.id}`);
    }
    printStep("pass", "uploads", `${uploaded.length} PDFs uploaded to the matter`);
    return uploaded;
}

async function documentReadiness(documentId: string): Promise<DocumentReadiness> {
    const db = createServerDb();
    const { data: doc, error: docError } = await db
        .from("documents")
        .select("id, filename, status, current_version_id, page_count")
        .eq("id", documentId)
        .maybeSingle();
    if (docError) throw new Error(docError.message);
    if (!doc) {
        return {
            documentId,
            filename: documentId,
            documentStatus: null,
            currentVersionId: null,
            storagePath: null,
            syncStatus: null,
            ingestionStatus: null,
            caseVaultId: null,
            caseObjectId: null,
            pageCount: null,
            textLength: null,
            chunkCount: null,
            vectorCount: null,
            error: "Document row not found",
            ready: false,
        };
    }

    const versionId = (doc.current_version_id as string | null | undefined) ?? null;
    let storagePath: string | null = null;
    if (versionId) {
        const { data: version, error: versionError } = await db
            .from("document_versions")
            .select("storage_path")
            .eq("id", versionId)
            .maybeSingle();
        if (versionError) throw new Error(versionError.message);
        storagePath = (version?.storage_path as string | null | undefined) ?? null;
    }

    let link: JsonRecord | null = null;
    if (versionId) {
        const { data: linkData, error: linkError } = await db
            .from("case_document_links")
            .select(
                "id, sync_status, ingestion_status, case_vault_id, case_object_id, page_count, text_length, chunk_count, vector_count, error",
            )
            .eq("document_id", documentId)
            .eq("version_id", versionId)
            .eq("role", "source")
            .maybeSingle();
        if (linkError) throw new Error(linkError.message);
        link = (linkData as JsonRecord | null) ?? null;
        link = await refreshCaseLinkIfNeeded(db, link);
    }

    const status = {
        documentId,
        filename: String(doc.filename ?? documentId),
        documentStatus: (doc.status as string | null | undefined) ?? null,
        currentVersionId: versionId,
        storagePath,
        syncStatus: (link?.sync_status as string | null | undefined) ?? null,
        ingestionStatus: (link?.ingestion_status as string | null | undefined) ?? null,
        caseVaultId: (link?.case_vault_id as string | null | undefined) ?? null,
        caseObjectId: (link?.case_object_id as string | null | undefined) ?? null,
        pageCount:
            typeof link?.page_count === "number"
                ? link.page_count
                : typeof doc.page_count === "number"
                  ? doc.page_count
                  : null,
        textLength: typeof link?.text_length === "number" ? link.text_length : null,
        chunkCount: typeof link?.chunk_count === "number" ? link.chunk_count : null,
        vectorCount: typeof link?.vector_count === "number" ? link.vector_count : null,
        error: (link?.error as string | null | undefined) ?? null,
        ready: false,
    };

    status.ready =
        status.documentStatus === "ready" &&
        !!status.currentVersionId &&
        !!status.storagePath?.startsWith("case://") &&
        status.syncStatus === "completed" &&
        status.ingestionStatus === "completed" &&
        !!status.caseVaultId &&
        !!status.caseObjectId;
    return status;
}

async function refreshCaseLinkIfNeeded(
    db: ReturnType<typeof createServerDb>,
    link: JsonRecord | null,
): Promise<JsonRecord | null> {
    const apiKey = process.env.MIKE_SMOKE_CASE_API_KEY?.trim();
    const linkId = typeof link?.id === "string" ? link.id : null;
    const vaultId =
        typeof link?.case_vault_id === "string" ? link.case_vault_id : null;
    const objectId =
        typeof link?.case_object_id === "string" ? link.case_object_id : null;
    if (!apiKey || !linkId || !vaultId || !objectId) return link;
    if (link?.sync_status === "completed" && link?.ingestion_status === "completed") {
        return link;
    }

    try {
        const object = await new CaseClient(apiKey).getVaultObject(vaultId, objectId);
        const ingestionStatus =
            object.ingestionStatus ?? (link.ingestion_status as string | null) ?? null;
        const completed = ingestionStatus === "completed";
        const failed = ingestionStatus === "failed";
        const patch = {
            sync_status: completed ? "completed" : failed ? "failed" : "ingesting",
            ingestion_status: ingestionStatus,
            page_count: object.pageCount ?? link.page_count ?? null,
            text_length: object.textLength ?? link.text_length ?? null,
            chunk_count: object.chunkCount ?? link.chunk_count ?? null,
            vector_count: object.vectorCount ?? link.vector_count ?? null,
            transcript_object_id: object.transcript_object_id ?? null,
            object_metadata: object.metadata ?? {},
            error: completed
                ? null
                : failed
                  ? object.ingestionError ?? "Case.dev ingestion failed."
                  : link.error ?? null,
            last_seen_at: new Date().toISOString(),
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        await db.from("case_document_links").update(patch).eq("id", linkId);
        return { ...link, ...patch };
    } catch {
        return link;
    }
}

function readinessLine(status: DocumentReadiness) {
    return [
        status.filename,
        `doc=${status.documentStatus ?? "missing"}`,
        `version=${status.currentVersionId ? "yes" : "no"}`,
        `storage=${status.storagePath?.startsWith("case://") ? "case" : status.storagePath ? "legacy" : "missing"}`,
        `sync=${status.syncStatus ?? "missing"}`,
        `ingest=${status.ingestionStatus ?? "missing"}`,
        `pages=${status.pageCount ?? "?"}`,
        `chunks=${status.chunkCount ?? "?"}`,
        `vectors=${status.vectorCount ?? "?"}`,
        status.error ? `error=${truncate(status.error, 120)}` : "",
    ]
        .filter(Boolean)
        .join(" | ");
}

async function waitForVaultIngestion(uploaded: SmokeDocument[]) {
    const deadline = Date.now() + timeoutMs;
    let lastPrint = "";
    let latest: DocumentReadiness[] = [];

    while (Date.now() < deadline) {
        latest = await Promise.all(uploaded.map((doc) => documentReadiness(doc.id)));
        const progress = latest.map(readinessLine).join("\n");
        if (progress !== lastPrint) {
            console.log("[smoke] vault ingestion status:");
            for (const status of latest) console.log(`  ${readinessLine(status)}`);
            lastPrint = progress;
        }

        const failed = latest.find(
            (status) =>
                status.documentStatus === "error" ||
                status.syncStatus === "failed" ||
                status.ingestionStatus === "failed",
        );
        if (failed) {
            throw new Error(`Vault ingestion failed for ${readinessLine(failed)}`);
        }

        if (latest.every((status) => status.ready)) {
            printStep("pass", "vault ingestion", `${latest.length} source objects completed`);
            return latest;
        }

        await sleep(pollMs);
    }

    throw new Error(
        `Timed out waiting for Case Vault ingestion:\n${latest.map(readinessLine).join("\n")}`,
    );
}

async function readSse(response: Response): Promise<ChatSmokeResult> {
    if (!response.body) throw new Error("SSE response had no body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let chatId: string | null = null;
    const events: JsonRecord[] = [];
    const toolNames = new Set<string>();
    const citations: JsonRecord[] = [];
    const docsCreated: JsonRecord[] = [];
    const errors: string[] = [];

    const processBlock = (block: string) => {
        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
            .trim();
        if (!data || data === "[DONE]") return;
        let event: JsonRecord;
        try {
            event = JSON.parse(data) as JsonRecord;
        } catch {
            errors.push(`Non-JSON SSE data: ${truncate(data, 160)}`);
            return;
        }
        events.push(event);
        if (event.type === "chat_id") {
            chatId = String(event.chatId ?? event.chat_id ?? "");
        } else if (event.type === "content_delta") {
            content += String(event.text ?? "");
        } else if (event.type === "tool_call_start" && typeof event.name === "string") {
            toolNames.add(event.name);
        } else if (event.type === "citations" && Array.isArray(event.citations)) {
            for (const citation of event.citations) {
                if (isRecord(citation)) citations.push(citation);
            }
        } else if (event.type === "doc_created") {
            docsCreated.push(event);
        } else if (event.type === "error") {
            errors.push(String(event.message ?? "Stream error"));
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            processBlock(block);
            boundary = buffer.indexOf("\n\n");
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);

    return {
        chatId: chatId || null,
        content,
        events,
        toolNames: [...toolNames],
        citations,
        docsCreated,
        errors,
    };
}

async function streamMatterChat(
    matterId: string,
    prompt: string,
    chatId?: string | null,
): Promise<ChatSmokeResult> {
    const headers = new Headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Origin: frontendUrl,
    });
    jar.apply(headers);
    const response = await fetch(
        `${backendUrl}/matters/${encodeURIComponent(matterId)}/chat`,
        {
            method: "POST",
            headers,
            body: JSON.stringify({
                chat_id: chatId ?? undefined,
                messages: [{ role: "user", content: prompt }],
            }),
        },
    );
    jar.capture(response.headers);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Chat prompt failed with ${response.status}: ${truncate(text)}`);
    }
    return readSse(response);
}

function looksTransientChatError(err: unknown, result?: ChatSmokeResult) {
    const text = [
        err instanceof Error ? err.message : String(err ?? ""),
        ...(result?.errors ?? []),
    ].join(" ");
    return (
        /Stream error/i.test(text) ||
        /too little visible content/i.test(text) ||
        /502/.test(text) ||
        /UPSTREAM_PROVIDER_UNAVAILABLE/i.test(text) ||
        /upstream provider unavailable/i.test(text)
    );
}

function requireChatResult(
    name: string,
    result: ChatSmokeResult,
    checks: {
        minChars?: number;
        anyTool?: string[];
        citations?: boolean;
        docCreated?: boolean;
    },
) {
    if (result.errors.length) {
        throw new Error(`${name} streamed errors: ${result.errors.join("; ")}`);
    }
    const minChars = checks.minChars ?? 80;
    if (result.content.trim().length < minChars) {
        throw new Error(
            `${name} produced too little visible content (${result.content.trim().length} chars).`,
        );
    }
    if (checks.anyTool?.length) {
        const used = result.toolNames.some((tool) => checks.anyTool!.includes(tool));
        if (!used) {
            throw new Error(
                `${name} did not use expected tools. saw=${result.toolNames.join(",") || "none"} expected=${checks.anyTool.join(",")}`,
            );
        }
    }
    if (checks.citations && result.citations.length === 0) {
        throw new Error(`${name} produced no Mike/Vault citations.`);
    }
    if (checks.docCreated && result.docsCreated.length === 0) {
        throw new Error(`${name} did not emit a doc_created event.`);
    }
}

async function runChatScenarioWithRetry(
    matterId: string,
    scenario: {
        name: string;
        prompt: string;
        minChars?: number;
        anyTool?: string[];
        citations?: boolean;
        docCreated?: boolean;
    },
    chatId: string | null,
): Promise<ChatSmokeResult> {
    const maxAttempts = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await streamMatterChat(matterId, scenario.prompt, chatId);
        try {
            requireChatResult(scenario.name, result, scenario);
            return result;
        } catch (err) {
            lastError = err;
            if (attempt >= maxAttempts || !looksTransientChatError(err, result)) {
                throw err;
            }
            console.log(
                `[smoke] ${scenario.name} hit a transient stream error; retrying (${attempt + 1}/${maxAttempts})`,
            );
            await sleep(3000 * attempt);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runChatScenarios(matterId: string) {
    let chatId: string | null = null;
    const scenarios = [
        {
            name: "vault/doc status",
            prompt:
                "List the documents in this matter and identify which appear to be deposition transcripts versus medical records.",
            anyTool: ["list_vault_documents", "search_documents", "list_documents"],
        },
        {
            name: "grounded search",
            prompt:
                "Summarize the key medical treatment facts across the records and cite the source documents.",
            anyTool: ["search_documents", "get_document_context", "read_document"],
            citations: true,
        },
        {
            name: "cross-document comparison",
            prompt:
                "Compare the two deposition transcripts on references to injuries, treatment, or medical history.",
            anyTool: [
                "search_documents",
                "get_document_context",
                "read_document",
                "fetch_documents",
                "find_in_document",
            ],
            citations: true,
        },
        {
            name: "skills discovery",
            prompt:
                "Find Case.dev skills relevant to deposition transcript summaries or medical chronologies and summarize the best matches.",
            anyTool: ["search_case_skills", "read_case_skill"],
        },
        {
            name: "legal research",
            prompt:
                "Find external legal authority about admissibility or use of medical records in litigation; cite external sources in prose.",
            anyTool: [
                "legal_research",
                "legal_source_text",
                "verify_legal_citations",
                "find_similar_legal_sources",
            ],
        },
        {
            name: "generated artifact",
            prompt:
                "Using targeted Vault searches for injuries, medical history, and treatment chronology, create a short DOCX chronology memo based on the matter documents. Keep it concise: 5 to 8 chronology bullets plus a brief source note.",
            anyTool: ["generate_docx"],
            docCreated: true,
        },
    ];

    let generatedDoc: JsonRecord | null = null;
    for (const scenario of scenarios) {
        console.log(`[smoke] chat prompt: ${scenario.name}`);
        const result = await runChatScenarioWithRetry(matterId, scenario, chatId);
        chatId = result.chatId ?? chatId;
        if (scenario.docCreated) {
            generatedDoc =
                result.docsCreated.find((doc) => typeof doc.document_id === "string") ??
                result.docsCreated[0] ??
                null;
        }
        printStep(
            "pass",
            `chat: ${scenario.name}`,
            `tools=${result.toolNames.join(",") || "none"} citations=${result.citations.length} chars=${result.content.trim().length}`,
        );
    }

    if (!generatedDoc) {
        throw new Error("Generated DOCX scenario did not return a generated document.");
    }
    await verifyGeneratedDoc(generatedDoc);

    console.log("[smoke] chat prompt: generated doc readback");
    const readback = await runChatScenarioWithRetry(
        matterId,
        {
            name: "generated doc readback",
            prompt:
                "Read back the generated chronology memo and summarize its title and sections.",
            minChars: 60,
            anyTool: ["read_document", "list_vault_documents", "search_documents"],
        },
        chatId,
    );
    requireChatResult("generated doc readback", readback, {
        minChars: 60,
        anyTool: ["read_document", "list_vault_documents", "search_documents"],
    });
    printStep(
        "pass",
        "chat: generated doc readback",
        `tools=${readback.toolNames.join(",") || "none"} chars=${readback.content.trim().length}`,
    );
}

async function verifyGeneratedDoc(generatedDoc: JsonRecord) {
    const downloadUrl = String(generatedDoc.download_url ?? "");
    const documentId = String(generatedDoc.document_id ?? "");
    if (!downloadUrl && !documentId) {
        throw new Error("Generated doc event had no download URL or document id.");
    }

    const bytes = downloadUrl
        ? await requestBytes(downloadUrl)
        : await requestBytes(`/single-documents/${encodeURIComponent(documentId)}/docx`);
    const header = Buffer.from(bytes.slice(0, 4)).toString("utf8");
    if (header !== "PK\u0003\u0004") {
        throw new Error("Generated document did not look like a DOCX zip.");
    }
    printStep(
        "pass",
        "generated DOCX",
        `${String(generatedDoc.filename ?? "document.docx")} read back (${bytes.byteLength} bytes)`,
    );
}

function printManualChecklist(user: { email: string; password: string }, matter: SmokeMatter) {
    console.log("");
    console.log("Manual UI checklist");
    console.log(`  1. Open ${frontendUrl}`);
    console.log(`  2. Log in as ${user.email}`);
    console.log(`     Password: ${user.password}`);
    console.log("  3. Confirm Account > Models shows LLM, Vault, Skills, Matters, and Legal ready.");
    console.log(`  4. Open Matter: ${matter.name} (${matter.id})`);
    console.log("  5. Confirm all three documents are ready, open/download one, and inspect chat citations.");
    console.log("  6. Confirm the bottom chat branding and login/landing branding say powered by case.dev.");
}

function printSummary() {
    console.log("");
    console.log("Smoke summary");
    for (const step of steps) {
        const label = step.status.toUpperCase().padEnd(4, " ");
        console.log(`  ${label} ${step.name} - ${step.detail}`);
    }
}

async function main() {
    console.log("Mike Case.dev smoke runner");
    console.log(`  backend:  ${backendUrl}`);
    console.log(`  frontend: ${frontendUrl}`);
    console.log(`  docs:     ${docsDir}`);
    console.log(`  timeout:  ${timeoutMs}ms`);
    console.log("");

    await healthCheck();
    await ensureFixtureDocs();

    if (dryRun) {
        printStep("skip", "mutating smoke flow", "dry run requested");
        printSummary();
        return;
    }

    if (!process.env.MIKE_SMOKE_CASE_API_KEY?.trim()) {
        throw new Error("MIKE_SMOKE_CASE_API_KEY is required for a real smoke run.");
    }

    const timestamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..+$/, "Z");
    const user = await createSmokeUser(timestamp);
    await saveCaseKey();
    const matter = await createMatter(timestamp);
    const uploaded = await uploadDocuments(matter.id);
    await waitForVaultIngestion(uploaded);
    await runChatScenarios(matter.id);
    printManualChecklist(user, matter);
    printSummary();
}

main().catch((err) => {
    printStep("fail", "smoke run", err instanceof Error ? err.message : String(err));
    printSummary();
    process.exitCode = 1;
});
