import path from "path";
import {
    downloadFile,
    generatedDocKey,
    storageKey,
    uploadFile,
} from "./storage";
import { convertedPdfKey } from "./convert";
import { createServerDb } from "./db";
import {
    applyTrackedEdits,
    extractDocxBodyText,
    type EditInput,
} from "./docxTrackedChanges";
import { buildDownloadUrl } from "./downloadTokens";
import { attachActiveVersionPaths, loadActiveVersion } from "./documentVersions";
import {
    getCaseDocumentContext,
    getCaseTextForDocument,
    listCaseVaultDocuments,
    registerCaseStoredObject,
    searchCaseDocuments,
    syncDocumentVersionToCase,
} from "./caseSync";
import type { CaseVaultSearchMethod } from "./caseClient";
import {
    composeWorkflowPrompt,
    getCaseSkillsClient,
    normalizeSkillTags,
    serializeSkill,
    summarizeSkill,
} from "./caseSkills";
import { caseClientForEffectiveKey, getEffectiveCaseApiKey } from "./caseCredentials";
import {
    streamChatWithTools,
    resolveModel,
    DEFAULT_MAIN_MODEL,
    type LlmMessage,
    type OpenAIToolSchema,
} from "./llm";
import { CaseApiError, CaseClient } from "./caseClient";

const STANDARD_FONT_DATA_URL = (() => {
    try {
        const pkgPath = require.resolve("pdfjs-dist/package.json");
        return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
    } catch {
        return undefined;
    }
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocStore = Map<
    string,
    { storage_path: string; file_type: string; filename: string }
>;

export type WorkflowStore = Map<
    string,
    {
        title: string;
        prompt_md: string;
        case_skill_slug?: string | null;
        case_skill_name?: string | null;
        case_skill_summary?: string | null;
        case_skill_tags?: string[] | unknown;
        case_skill_source?: string | null;
        case_skill_version?: string | number | null;
        case_skill_synced_at?: string | null;
    }
>;

export type DocIndex = Record<
    string,
    {
        document_id: string;
        filename: string;
        version_id?: string | null;
        version_number?: number | null;
    }
>;

export type TabularCellStore = {
    columns: { index: number; name: string }[];
    documents: { id: string; filename: string }[];
    /** key: `${colIndex}:${docId}` */
    cells: Map<string, { summary: string; flag?: string; reasoning?: string } | null>;
};

export type ToolCall = {
    id: string;
    function: { name: string; arguments: string };
};

export type ChatMessage = {
    role: string;
    content: string | null;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are Mike, an AI legal assistant that helps lawyers and legal professionals analyze documents, answer legal questions, and draft legal documents.

DOCUMENT CITATION INSTRUCTIONS:
When you reference specific content from a document, place a numbered marker [1], [2], etc. inline in your prose at the point of reference.

After your complete response, append a <CITATIONS> block containing a JSON array with one entry per marker:

<CITATIONS>
[
  {"ref": 1, "doc_id": "doc-0", "page": 3, "quote": "exact verbatim text from the document"},
  {"ref": 2, "doc_id": "doc-1", "page": "41-42", "quote": "Section 4.2 describes the procedure [[PAGE_BREAK]] in all material respects.", "chunk_index": 12, "case_object_id": "obj_abc123"}
]
</CITATIONS>

CRITICAL: The number inside the [N] marker in your prose is the "ref" value of a citation entry in the <CITATIONS> block — it is NOT a page number, footnote number, section number, or any other number that appears in the document. The marker [1] refers to the entry with "ref": 1 in the JSON block; [2] refers to "ref": 2; and so on. Refs are simple sequential integers you assign (1, 2, 3, …) in the order citations appear in your prose. Never use a page number or a document's own numbering as the marker number. Every [N] you write in prose MUST have a matching {"ref": N, ...} entry in the JSON block.

Rules:
- Only cite text that appears verbatim in the provided documents
- In every <CITATIONS> entry, "doc_id" MUST be the exact chat-local document label you were given (for example "doc-0"). Never use a filename, document UUID, or any other identifier in "doc_id"
- Keep quotes short (ideally ≤ 25 words) and narrowly scoped to the specific claim. Don't reuse one quote to support multiple different claims — give each its own citation
- "page" refers to the sequential [Page N] marker in the text you were given (1-indexed from the first page). IGNORE any page numbers printed inside the document itself (footers, roman numerals, etc.)
- For a single-page quote, set "page" to an integer. If a quote is one continuous sentence that spans two pages, set "page" to "N-M" and insert [[PAGE_BREAK]] in the quote at the page break. Otherwise, use separate citations for text on different pages
- When citing from search_documents or get_document_context results, include returned Case.dev grounding fields when available: "chunk_index", "case_object_id", "case_vault_id", "word_start_index", and "word_end_index". Do not invent these fields
- Put the <CITATIONS> block at the very end of the response. Omit it entirely if there are no citations

DOCX GENERATION:
If asked to draft or generate a document, use the generate_docx tool to produce a downloadable Word document. Always use this tool rather than just displaying the document content inline when the user asks for a document to be created.
If the user follows up on a document you just generated and asks for changes (e.g. "make section 3 longer", "add a termination clause", "change the parties"), default to calling edit_document on that newly generated document — do NOT call generate_docx again to regenerate the whole document. Only fall back to generate_docx if the user explicitly asks for a brand-new document or the change is so sweeping that an edit would not be coherent.
After calling generate_docx, do NOT include any download links, URLs, or markdown links to the document in your prose response — the download card is presented automatically by the UI. Do not describe formatting choices such as orientation or layout.
After calling generate_docx, you MUST call read_document on the returned doc_id before writing your prose response. Base your description on the generated document's actual text, not on memory of what you intended to generate.
Your prose response MUST include a short description of the generated document: what it is, its structure (key sections/clauses), and — if the draft was informed by any provided source documents — which sources you drew from and how. Keep it concise (typically 3–8 sentences or a short bulleted list). Refer to the document by filename, never by a download link.
When the description makes factual claims about the contents of the newly generated document, cite the generated document with [N] markers and a <CITATIONS> block exactly as specified in the DOCUMENT CITATION INSTRUCTIONS above. If you also make factual claims about provided source documents, cite those source documents separately. In every citation entry, use the exact chat-local doc_id label for the cited document. Omit the <CITATIONS> block if the description makes no such claims.
Heading hierarchy: always use Heading 1 before introducing Heading 2, Heading 2 before Heading 3, and so on. Never skip levels (e.g. do not jump from Heading 1 to Heading 3).
Numbering: all numbering MUST start from 1, never 0. This applies at every level of the hierarchy — use 1., 1.1, 1.1.1, 1.1.1.1, etc. Never produce 0., 0.1, 1.0, 1.0.1, or any other sequence that begins a level with 0.
Never duplicate the numbering prefix in heading text. The heading's own numbering is applied automatically by the document generator, so the heading text must contain the title only — do NOT prepend "1.", "1.1", "2.", etc. into the heading text itself. For example, a Heading 1 titled "Introduction" must be passed as "Introduction", never as "1. Introduction" (which would render as "1. 1. Introduction"). The same rule applies at every level.
Contracts: when generating a contract or agreement, always include a signatures block at the very end of the document on its own page. Set pageBreak: true on that final section so it starts on a fresh page, and include a signature line for each party — typically the party name followed by lines for "By:", "Name:", "Title:", and "Date:". Do not number the signatures heading; put the signature block in the section's content rather than as a numbered heading.
Contract preambles: the preamble of a contract (the opening recitals, parties block, "WHEREAS" clauses, and any introductory narrative before the first operative clause) must NOT be numbered. Render these as unnumbered content (plain paragraphs or an unnumbered heading), and begin numbering only at the first operative clause/section.

DOCUMENT EDITING:
When using edit_document, any edit that adds, removes, or reorders a numbered clause, section, sub-clause, schedule, exhibit, or list item shifts every downstream number. You MUST update all affected numbering AND every cross-reference to those numbers in the same edit_document call:
- Renumber the sibling clauses/sections/sub-clauses that follow the change so the sequence stays contiguous (e.g. if you insert a new Section 4, existing Sections 4, 5, 6… become 5, 6, 7…).
- Find every in-document reference to the shifted numbers — e.g. "see Section 5", "pursuant to Clause 4.2(b)", "as set out in Schedule 3", "defined in Section 2.1" — and update them to the new numbers. Include defined-term blocks, cross-references in recitals, schedules, and exhibits.
- Before issuing the edits, scan the full document (use read_document or find_in_document) to enumerate affected cross-references; do not assume references only appear near the change site.
- If you are uncertain whether a reference points to the shifted number or an unrelated number, err on the side of including it as an edit and explain in the reason field.
- When deleting square brackets, delete both the opening \`[\` and the closing \`]\`. Never leave behind an unmatched square bracket after an edit.

WORKFLOWS:
When a user message begins with a [Workflow: <title> (id: <id>)] marker, the user has selected a workflow and you MUST apply it. Immediately call the read_workflow tool with that exact id to load the workflow's full prompt, then follow those instructions for the current turn. Do this before producing any other output or calling any other tools (aside from any document reads the workflow requires). Do not ask the user to confirm — the selection itself is the instruction to apply the workflow.

CASE.DEV SKILLS:
Case.dev skills are reusable legal work instructions that may or may not already be imported as Mike workflows. When the user asks to find, browse, reference, choose, compare, or use a skill, call search_case_skills first. If the user asks to use or apply a specific skill, call read_case_skill with the returned slug and then follow that skill's instructions for the current turn. If read_case_skill says the skill is already imported as a workflow, prefer read_workflow on that workflow_id so Mike-specific workflow overlays are included. Do not claim a Case.dev skill exists unless search_case_skills or read_case_skill returned it.

CASE.DEV VAULT SEARCH:
Matter/project documents are stored and indexed in Case.dev Vaults. For questions across many files, call list_vault_documents first when you need processing status or filenames, then search_documents. Use method "hybrid" for ordinary passage-finding, "fast" for quick similarity, "global" for corpus-wide themes or contradictions, and "local" or "entity" for questions about a named person, organization, or concept. If search returns a chunk that needs more context, call get_document_context with the returned doc_id and chunk_index before answering.

CASE.DEV LEGAL RESEARCH:
Use the legal research tools for external legal authority, citation verification, court/docket lookup, SEC filings, patents, trademarks, and other law or public-source research. Use Vault tools for uploaded matter documents and Legal tools for outside authorities; use both when a question asks you to compare matter facts against external law. External authority citations should be written in prose as canonical citations and/or Markdown links returned by the Legal tools. Do NOT put external authority citations in the <CITATIONS> JSON block, which is reserved only for Mike/Vault document citations. Never claim you performed a live PACER fetch, never ask Case.dev to incur PACER fees, and do not request docket entries unless a tool result explicitly says they are available.

DOCUMENT NAMING IN PROSE:
The chat-local labels ("doc-0", "doc-1", "doc-N", …) are internal handles for tool calls and citation JSON ONLY. NEVER write them in your prose response or in any text the user reads — not in body text, not in headings, not in lists, not in tool-activity descriptions. The user does not know what "doc-0" means and seeing it is jarring. When referring to a document in prose, always use its filename (e.g. "the NDA draft" or "nda_v1.docx"). This rule applies to every word streamed back to the user; the only places "doc-N" identifiers are allowed are inside tool-call arguments and inside the <CITATIONS> JSON block's "doc_id" field.

GENERAL GUIDANCE:
- Be precise and professional
- Cite the specific document and quote when making claims about document content
- When no documents are provided, answer based on your legal knowledge
- Do not fabricate document content
- Do not use emojis in your responses.
`;

export const PROJECT_EXTRA_TOOLS = [
    {
        type: "function",
        function: {
            name: "list_documents",
            description:
                "List all documents available in the project. Returns each document's ID, filename, and file type. Call this to discover what documents are available before deciding which ones to read.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_documents",
            description:
                "Read the full text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once.",
            parameters: {
                type: "object",
                properties: {
                    doc_ids: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])",
                    },
                },
                required: ["doc_ids"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "replicate_document",
            description:
                "Make byte-for-byte copies of an existing project document as new project documents. Use when the user wants standalone copies to edit (e.g. 'use this NDA as a template', 'give me three drafts I can adapt') without modifying the original. Pass `count` to create multiple copies in a single call rather than calling the tool repeatedly. Returns the new doc_id slugs so you can immediately call edit_document / read_document on them.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description:
                            "ID of the source document to copy (e.g. 'doc-0').",
                    },
                    count: {
                        type: "integer",
                        description:
                            "How many copies to create. Defaults to 1. Maximum 20.",
                        minimum: 1,
                        maximum: 20,
                    },
                    new_filename: {
                        type: "string",
                        description:
                            "Optional base filename. With count > 1, copies are suffixed (e.g. 'Foo (1).docx', 'Foo (2).docx'). Extension is forced to match the source.",
                    },
                },
                required: ["doc_id"],
            },
        },
    },
];

export const TABULAR_TOOLS = [
    {
        type: "function",
        function: {
            name: "read_table_cells",
            description:
                "Read the extracted cell content from the tabular review. Each cell contains the value extracted for a specific column from a specific document. Pass col_indices and/or row_indices (0-based) to read a subset; omit either to read all columns or all rows.",
            parameters: {
                type: "object",
                properties: {
                    col_indices: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "0-based column indices to read (e.g. [0, 2]). Omit to read all columns.",
                    },
                    row_indices: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "0-based document (row) indices to read (e.g. [0, 1]). Omit to read all rows.",
                    },
                },
            },
        },
    },
];

export const WORKFLOW_TOOLS = [
    {
        type: "function",
        function: {
            name: "list_workflows",
            description:
                "List all workflows available to the user. Returns each workflow's ID and title. Call this when the user asks to run a workflow, apply a template, or you need to discover what workflows exist.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "read_workflow",
            description:
                "Read the full instructions (prompt) of a workflow by its ID. Call this after list_workflows to load a specific workflow's prompt, then follow those instructions.",
            parameters: {
                type: "object",
                properties: {
                    workflow_id: {
                        type: "string",
                        description: "The workflow ID to read",
                    },
                },
                required: ["workflow_id"],
            },
        },
    },
];

export const SKILL_TOOLS = [
    {
        type: "function",
        function: {
            name: "search_case_skills",
            description:
                "Search Case.dev skills and imported Case-backed Mike workflows. Call this when the user asks to find, browse, choose, compare, reference, or use skills. Returns skill slugs, summaries, tags, source, version, and any imported workflow ID.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Natural-language skill search query, such as 'deposition prep', 'privilege review', or a skill name. Leave empty only when listing already-imported or custom skills.",
                    },
                    source: {
                        type: "string",
                        enum: ["all", "case", "custom", "imported"],
                        description:
                            "Which skills to search. Defaults to all. 'case' searches the Case catalog, 'custom' lists the user's custom skills, and 'imported' searches Case skills already imported as workflows.",
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum number of skills to return. Defaults to 10.",
                        minimum: 1,
                        maximum: 20,
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_case_skill",
            description:
                "Read the full instructions for a Case.dev skill by slug. Call this after search_case_skills when the user wants to reference, inspect, or apply a skill in the current chat turn.",
            parameters: {
                type: "object",
                properties: {
                    slug: {
                        type: "string",
                        description: "The Case.dev skill slug returned by search_case_skills.",
                    },
                },
                required: ["slug"],
            },
        },
    },
];

export const LEGAL_TOOLS = [
    {
        type: "function",
        function: {
            name: "legal_research",
            description:
                "Search external legal sources using Case.dev Legal. Use mode 'find' for focused source search and 'research' for deeper research with synthesized results. Do not use for uploaded matter documents; use Vault tools for those.",
            parameters: {
                type: "object",
                properties: {
                    mode: {
                        type: "string",
                        enum: ["find", "research"],
                        description:
                            "Use 'find' for focused search and 'research' for deeper legal research. Defaults to find.",
                    },
                    query: {
                        type: "string",
                        description:
                            "Legal research query, issue, party, case name, statute, or concept.",
                    },
                    additional_queries: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Optional extra queries for deep research mode.",
                    },
                    jurisdiction: {
                        type: "string",
                        description:
                            "Optional jurisdiction filter. Use legal_dockets with operation 'resolve_jurisdiction' if unsure.",
                    },
                    num_results: {
                        type: "integer",
                        description: "Number of sources/results to return. Defaults to 10.",
                        minimum: 1,
                        maximum: 25,
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "legal_source_text",
            description:
                "Retrieve full text or a highlighted excerpt for an external legal source URL returned by legal_research, legal_dockets, or find_similar_legal_sources.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "The external legal source URL to retrieve.",
                    },
                    max_characters: {
                        type: "integer",
                        description:
                            "Maximum characters to return. Defaults to the API default.",
                        minimum: 500,
                        maximum: 50000,
                    },
                    highlight_query: {
                        type: "string",
                        description:
                            "Optional query to highlight relevant portions of the source.",
                    },
                    summary_query: {
                        type: "string",
                        description:
                            "Optional question or issue for source-specific summarization.",
                    },
                },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "verify_legal_citations",
            description:
                "Extract or verify legal citations from text, or extract citations from a URL. Use this when the user asks whether citations are real, accurate, or supported.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["verify", "extract"],
                        description:
                            "Use verify for text citation validation and extract to only parse citations. URL inputs use Case.dev's URL citation extraction endpoint.",
                    },
                    text: {
                        type: "string",
                        description:
                            "Text containing one or more legal citations.",
                    },
                    url: {
                        type: "string",
                        description:
                            "URL of a legal source to extract citations from.",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_similar_legal_sources",
            description:
                "Find cases or legal documents similar to an external legal source URL.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "Source URL to find similar legal sources for.",
                    },
                    jurisdiction: {
                        type: "string",
                        description: "Optional jurisdiction filter.",
                    },
                    num_results: {
                        type: "integer",
                        description: "Number of similar sources to return. Defaults to 10.",
                        minimum: 1,
                        maximum: 25,
                    },
                    start_published_date: {
                        type: "string",
                        description:
                            "Optional ISO date to find only newer sources, e.g. 2020-01-01.",
                    },
                },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "legal_dockets",
            description:
                "Resolve jurisdictions/courts, search free federal dockets, or look up a docket by ID. Live PACER fetches and docket entry listing are disabled.",
            parameters: {
                type: "object",
                properties: {
                    operation: {
                        type: "string",
                        enum: [
                            "resolve_jurisdiction",
                            "list_courts",
                            "search",
                            "lookup",
                        ],
                        description:
                            "Operation to perform: resolve_jurisdiction, list_courts, search dockets, or lookup a docket ID.",
                    },
                    name: {
                        type: "string",
                        description:
                            "Jurisdiction name for resolve_jurisdiction.",
                    },
                    query: {
                        type: "string",
                        description:
                            "Court search query or docket search query, such as a party or case name.",
                    },
                    jurisdiction: {
                        type: "string",
                        description:
                            "Optional jurisdiction code for court lookup, e.g. FD, FA, S.",
                    },
                    court: {
                        type: "string",
                        description:
                            "Optional court slug for docket search, e.g. cand or ca9.",
                    },
                    docket_id: {
                        type: "string",
                        description: "Docket ID for lookup.",
                    },
                    date_filed_after: {
                        type: "string",
                        description: "Optional lower filing-date bound, YYYY-MM-DD.",
                    },
                    date_filed_before: {
                        type: "string",
                        description: "Optional upper filing-date bound, YYYY-MM-DD.",
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum results to return.",
                        minimum: 1,
                        maximum: 100,
                    },
                    offset: {
                        type: "integer",
                        description: "Pagination offset.",
                        minimum: 0,
                    },
                },
                required: ["operation"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "legal_sec_filings",
            description:
                "Search SEC EDGAR filings or fetch a public-company/entity filing history.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: ["search", "entity"],
                        description:
                            "Run full-text filing search or fetch a single entity filing history.",
                    },
                    query: {
                        type: "string",
                        description: "Full-text SEC search query.",
                    },
                    form_types: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Optional form filters, such as 10-K, 10-Q, 8-K, or 4.",
                    },
                    ticker: {
                        type: "string",
                        description: "Optional company ticker.",
                    },
                    entity: {
                        type: "string",
                        description: "Optional company/entity name.",
                    },
                    cik: {
                        type: "string",
                        description: "Optional CIK for entity lookup.",
                    },
                    date_after: {
                        type: "string",
                        description: "Optional lower filing-date bound, YYYY-MM-DD.",
                    },
                    date_before: {
                        type: "string",
                        description: "Optional upper filing-date bound, YYYY-MM-DD.",
                    },
                    limit: { type: "integer", minimum: 1, maximum: 100 },
                    offset: { type: "integer", minimum: 0 },
                },
                required: ["type"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "legal_patent_search",
            description:
                "Search USPTO patent applications and grants using Case.dev Legal.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Patent search query." },
                    application_status: { type: "string" },
                    application_type: { type: "string" },
                    assignee: { type: "string" },
                    inventor: { type: "string" },
                    filing_date_from: { type: "string" },
                    filing_date_to: { type: "string" },
                    grant_date_from: { type: "string" },
                    grant_date_to: { type: "string" },
                    limit: { type: "integer", minimum: 1, maximum: 100 },
                    offset: { type: "integer", minimum: 0 },
                    sort_by: { type: "string" },
                    sort_order: { type: "string", enum: ["asc", "desc"] },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "legal_trademark_lookup",
            description:
                "Look up USPTO trademark status and details by serial number or registration number.",
            parameters: {
                type: "object",
                properties: {
                    serial_number: {
                        type: "string",
                        description: "USPTO serial number.",
                    },
                    registration_number: {
                        type: "string",
                        description: "USPTO registration number.",
                    },
                },
            },
        },
    },
];

export const TOOLS = [
    {
        type: "function",
        function: {
            name: "list_vault_documents",
            description:
                "List Case.dev Vault status for the documents available in this chat or matter. Use this before broad document work when you need filenames, processing status, page counts, chunk counts, graph readiness, or whether documents are searchable.",
            parameters: {
                type: "object",
                properties: {
                    doc_ids: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Optional document IDs to inspect (e.g. ['doc-0', 'doc-2']). Omit to list all available documents.",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_document",
            description:
                "Read the full text content of a document attached by the user. Always call this before answering questions about, summarising, or citing from a document.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description:
                            "The document ID to read (e.g. 'doc-0', 'doc-1')",
                    },
                },
                required: ["doc_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_documents",
            description:
                "Search across the available Case.dev-indexed documents by meaning. Use this when you need to locate relevant passages across one or more documents before deciding what to read or cite. Returns matching chunks hydrated with neighboring context, document IDs, filenames, and page ranges when available.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Natural-language search query.",
                    },
                    doc_ids: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Optional document IDs to limit the search (e.g. ['doc-0', 'doc-2']). Omit to search all available documents.",
                    },
                    top_k: {
                        type: "integer",
                        description:
                            "Maximum number of chunks to return. Defaults to 10.",
                        minimum: 1,
                        maximum: 50,
                    },
                    method: {
                        type: "string",
                        enum: ["hybrid", "fast", "local", "global", "entity"],
                        description:
                            "Case.dev Vault search mode. Defaults to hybrid. Use global for corpus-wide synthesis and local/entity for named-person or named-entity questions.",
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_document_context",
            description:
                "Retrieve exact Case.dev Vault chunks around a search result. Use this when search_documents returns a relevant chunk but you need neighboring context, page ranges, or OCR word-index metadata before answering or citing.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description: "Document ID returned by search_documents, e.g. 'doc-0'.",
                    },
                    chunk_index: {
                        type: "integer",
                        description: "Chunk index returned by search_documents.",
                    },
                    before: {
                        type: "integer",
                        minimum: 0,
                        maximum: 10,
                        description: "How many chunks before the target to include. Defaults to 1.",
                    },
                    after: {
                        type: "integer",
                        minimum: 0,
                        maximum: 10,
                        description: "How many chunks after the target to include. Defaults to 1.",
                    },
                },
                required: ["doc_id", "chunk_index"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_in_document",
            description:
                "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, or a specific phrase) rather than reading the whole document.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description:
                            "The document ID to search (e.g. 'doc-0').",
                    },
                    query: {
                        type: "string",
                        description:
                            "The string to search for. Matching is case-insensitive and collapses runs of whitespace, so 'Section 4.2' matches 'section   4.2'.",
                    },
                    max_results: {
                        type: "integer",
                        description:
                            "Maximum number of matches to return (default 20). Use a smaller value for common terms.",
                    },
                    context_chars: {
                        type: "integer",
                        description:
                            "Characters of surrounding context to include on each side of a match (default 80).",
                    },
                },
                required: ["doc_id", "query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "generate_docx",
            description:
                "Generate a Word (.docx) document from structured content. Use this when the user asks you to draft, create, or produce a legal document. Returns a download URL for the generated file.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "Document title (used as filename and heading)",
                    },
                    landscape: {
                        type: "boolean",
                        description: "Set to true for landscape page orientation. Default is portrait.",
                    },
                    sections: {
                        type: "array",
                        description: "List of document sections. Each section may contain a heading, prose content, or a table.",
                        items: {
                            type: "object",
                            properties: {
                                heading: { type: "string", description: "Optional section heading" },
                                level: { type: "integer", description: "Heading level: 1, 2, or 3" },
                                content: { type: "string", description: "Prose text content (paragraphs separated by double newlines)" },
                                pageBreak: { type: "boolean", description: "Set to true to start this section on a new page. Use for contract signature pages." },
                                table: {
                                    type: "object",
                                    description: "Optional table to render in this section",
                                    properties: {
                                        headers: {
                                            type: "array",
                                            items: { type: "string" },
                                            description: "Column header labels",
                                        },
                                        rows: {
                                            type: "array",
                                            items: {
                                                type: "array",
                                                items: { type: "string" },
                                            },
                                            description: "Array of rows, each row is an array of cell strings matching the headers order",
                                        },
                                    },
                                    required: ["headers", "rows"],
                                },
                            },
                        },
                    },
                },
                required: ["title", "sections"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "edit_document",
            description:
                "Propose edits to a user-attached .docx as tracked changes. Each edit is a precise, minimal substitution of specific words/characters, NOT a whole-line or paragraph replacement. Use read_document first. Anchor each edit with short before/after context so it can be located unambiguously. Returns per-edit annotations the UI will render as Accept/Reject cards and a download link to the edited document.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description: "Document slug (e.g. 'doc-0').",
                    },
                    edits: {
                        type: "array",
                        description: "List of precise substitutions.",
                        items: {
                            type: "object",
                            properties: {
                                find: {
                                    type: "string",
                                    description:
                                        "Exact substring to replace (keep it as short as possible — ideally just the words/chars being changed).",
                                },
                                replace: {
                                    type: "string",
                                    description: "Replacement text. Empty string = pure deletion.",
                                },
                                context_before: {
                                    type: "string",
                                    description: "~40 chars immediately preceding `find`, used to disambiguate.",
                                },
                                context_after: {
                                    type: "string",
                                    description: "~40 chars immediately following `find`.",
                                },
                                reason: {
                                    type: "string",
                                    description: "Short explanation shown to the user on the card.",
                                },
                            },
                            required: ["find", "replace", "context_before", "context_after"],
                        },
                    },
                },
                required: ["doc_id", "edits"],
            },
        },
    },
];

type ParsedCitation = {
    ref: number;
    doc_id: string;
    page: number | string;
    quote: string;
    case_vault_id?: string | null;
    case_object_id?: string | null;
    chunk_index?: number | null;
    word_start_index?: number | null;
    word_end_index?: number | null;
};

function normalizeCitation(raw: unknown): ParsedCitation | null {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.ref !== "number" || typeof c.doc_id !== "string") return null;
    if (typeof c.quote !== "string" || !c.quote) return null;
    let page: number | string;
    if (typeof c.page === "number") {
        page = c.page;
    } else if (typeof c.page === "string" && /^\d+\s*-\s*\d+$/.test(c.page)) {
        page = c.page;
    } else {
        const n = parseInt(String(c.page ?? ""), 10);
        if (!Number.isFinite(n)) return null;
        page = n;
    }
    return {
        ref: c.ref,
        doc_id: c.doc_id,
        page,
        quote: c.quote,
        case_vault_id:
            typeof c.case_vault_id === "string" ? c.case_vault_id : null,
        case_object_id:
            typeof c.case_object_id === "string" ? c.case_object_id : null,
        chunk_index:
            typeof c.chunk_index === "number" ? c.chunk_index : null,
        word_start_index:
            typeof c.word_start_index === "number" ? c.word_start_index : null,
        word_end_index:
            typeof c.word_end_index === "number" ? c.word_end_index : null,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function resolveDoc(rawId: string, docIndex: DocIndex) {
    return docIndex[rawId];
}

/**
 * Resolve whatever identifier the model passed (`doc-N` slug, filename, or
 * document UUID) back to a chat-local doc label. Generated docs surface in
 * tool results with both `doc_id` (slug) and `document_id` (UUID), so the
 * model often picks the wrong one — without this fallback `read_document`
 * silently returns "not found" and the model gives up and re-generates.
 */
export function resolveDocLabel(
    rawId: string,
    docStore: DocStore,
    docIndex?: DocIndex,
): string | null {
    if (docStore.has(rawId)) return rawId;
    for (const [label, info] of docStore.entries()) {
        if (info.filename === rawId) return label;
    }
    if (docIndex) {
        for (const [label, info] of Object.entries(docIndex)) {
            if (info.document_id === rawId) return label;
        }
    }
    return null;
}

/**
 * Append a tool-activity summary to the most recent assistant message so
 * the model can see what it just did (read / create / edit / workflow
 * applied) in the prior turn — otherwise it only sees its own prose and
 * forgets which docs it touched, which leads to e.g. re-generating a doc
 * that already exists.
 *
 * Doc references use the *current-turn* `doc_id` slug (looked up by
 * matching the event's stored `document_id` against this turn's freshly
 * built `docIndex`), since slugs are reassigned every turn and the old
 * slug from the prior turn would be meaningless. Falls back to filename
 * only if the doc is no longer in the index (deleted, scope changed).
 */
export async function enrichWithPriorEvents(
    messages: ChatMessage[],
    chatId: string | null | undefined,
    db: ReturnType<typeof createServerDb>,
    docIndex: DocIndex,
): Promise<ChatMessage[]> {
    if (!chatId) return messages;
    const { data: rows } = await db
        .from("chat_messages")
        .select("content, created_at")
        .eq("chat_id", chatId)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1);

    const lastRow = rows?.[0] as { content?: unknown } | undefined;
    const content = lastRow?.content;
    if (!Array.isArray(content)) return messages;

    const slugByDocumentId = new Map<string, string>();
    for (const [slug, info] of Object.entries(docIndex)) {
        if (info.document_id) slugByDocumentId.set(info.document_id, slug);
    }
    const refFor = (documentId: unknown, filename: unknown) => {
        const slug =
            typeof documentId === "string"
                ? slugByDocumentId.get(documentId)
                : undefined;
        return slug ? `${slug} ("${filename}")` : `"${filename}"`;
    };

    const lines: string[] = [];
    for (const ev of content as Record<string, unknown>[]) {
        if (ev?.type === "doc_created") {
            lines.push(
                `- generate_docx → ${refFor(ev.document_id, ev.filename)}`,
            );
        } else if (ev?.type === "doc_edited") {
            lines.push(
                `- edit_document → ${refFor(ev.document_id, ev.filename)}`,
            );
        } else if (ev?.type === "doc_read") {
            lines.push(
                `- read_document → ${refFor(ev.document_id, ev.filename)}`,
            );
        } else if (ev?.type === "doc_replicated") {
            // The model needs to know what each copy resolved to so it
            // can call edit_document / read_document on them. Emit one
            // line per copy, all attributed back to the same source.
            const srcLabel =
                typeof ev.filename === "string" ? `"${ev.filename}"` : "";
            const copies = Array.isArray(ev.copies)
                ? (ev.copies as {
                      new_filename?: unknown;
                      document_id?: unknown;
                  }[])
                : [];
            for (const c of copies) {
                const ref = refFor(c.document_id, c.new_filename);
                lines.push(
                    srcLabel
                        ? `- replicate_document → ${ref} (copy of ${srcLabel})`
                        : `- replicate_document → ${ref}`,
                );
            }
        } else if (ev?.type === "workflow_applied") {
            lines.push(`- applied workflow: "${ev.title}"`);
        }
    }
    if (lines.length === 0) return messages;
    const summary = `\n\n[Tool activity in your previous turn]\n${lines.join("\n")}`;

    // Find the index of the last assistant message and attach the
    // summary there only.
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
            lastAssistantIdx = i;
            break;
        }
    }
    if (lastAssistantIdx < 0) return messages;
    const enriched = messages.slice();
    const target = enriched[lastAssistantIdx];
    enriched[lastAssistantIdx] = {
        ...target,
        content: (target.content ?? "") + summary,
    };
    return enriched;
}

export function buildMessages(
    messages: ChatMessage[],
    docAvailability: { doc_id: string; filename: string; folder_path?: string }[],
    systemPromptExtra?: string,
    docIndex?: DocIndex,
) {
    const formatted: unknown[] = [];
    let systemContent = SYSTEM_PROMPT;

    if (systemPromptExtra) {
        systemContent += `\n\n${systemPromptExtra.trim()}`;
    }

    if (docAvailability.length) {
        systemContent += "\n\n---\nAVAILABLE DOCUMENTS:\n";
        for (const doc of docAvailability) {
            const label = doc.folder_path ? `${doc.folder_path} / ${doc.filename}` : doc.filename;
            systemContent += `- ${doc.doc_id}: ${label}\n`;
        }
        systemContent +=
            "\nYou do NOT retain document content between conversation turns. You MUST call read_document, fetch_documents, or search_documents at the start of every response that involves a document's content, even if you have read it in a previous turn. Failure to do so will result in hallucinated or stale content.\n---\n";
    }
    formatted.push({ role: "system", content: systemContent });

    // Map document_id (UUID) → current-turn doc_id slug, so when we
    // inline a user attachment we hand the model the same handle it
    // would use to call read_document / fetch_documents.
    const slugByDocumentId = new Map<string, string>();
    if (docIndex) {
        for (const [slug, info] of Object.entries(docIndex)) {
            if (info.document_id) slugByDocumentId.set(info.document_id, slug);
        }
    }

    for (const msg of messages) {
        let content = msg.content ?? "";
        if (msg.role === "user" && msg.workflow) {
            content = `[Workflow: ${msg.workflow.title} (id: ${msg.workflow.id})]\n\n${content}`;
        }
        if (msg.role === "user" && msg.files?.length) {
            const lines = msg.files.map((f) => {
                const slug = f.document_id
                    ? slugByDocumentId.get(f.document_id)
                    : undefined;
                return slug
                    ? `- ${slug}: ${f.filename}`
                    : `- ${f.filename}`;
            });
            content = `[The user attached the following document(s) to this message:\n${lines.join("\n")}]\n\n${content}`;
        }
        formatted.push({ role: msg.role, content });
    }
    return formatted;
}

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({
            data: new Uint8Array(buf),
            standardFontDataUrl: STANDARD_FONT_DATA_URL,
        }).promise;
        const parts: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            parts.push(
                `[Page ${i}]\n${textContent.items.map((it) => it.str ?? "").join(" ")}`,
            );
        }
        return parts.join("\n\n");
    } catch {
        return "";
    }
}

export async function generateDocx(
    title: string,
    sections: unknown[],
    userId: string,
    db: ReturnType<typeof createServerDb>,
    options?: { landscape?: boolean; projectId?: string | null },
) {
    try {
        const {
            Document, Paragraph, HeadingLevel, Packer,
            Table, TableRow, TableCell, WidthType, BorderStyle,
            TextRun, AlignmentType, PageOrientation, PageBreak,
        } = await import("docx");

        const FONT = "Times New Roman";
        const SIZE = 22; // 11pt in half-points

        type DocChild = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
        const children: DocChild[] = [];
        children.push(
            new Paragraph({
                heading: HeadingLevel.TITLE,
                spacing: { after: 200 },
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: title.toUpperCase(), color: "000000", font: FONT, size: SIZE, bold: true })],
            }),
        );

        const cellBorder = {
            top:    { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            left:   { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            right:  { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
        };

        const headingLevels = [
            HeadingLevel.HEADING_1,
            HeadingLevel.HEADING_2,
            HeadingLevel.HEADING_3,
            HeadingLevel.HEADING_4,
        ];
        const counters = [0, 0, 0, 0];

        for (const section of sections as {
            heading?: string;
            content?: string;
            level?: number;
            pageBreak?: boolean;
            table?: { headers: string[]; rows: string[][] };
        }[]) {
            if (section.pageBreak) {
                children.push(
                    new Paragraph({ children: [new PageBreak()] }),
                );
            }
            if (section.heading) {
                const idx = Math.min((section.level ?? 1) - 1, 3);
                counters[idx]++;
                for (let i = idx + 1; i < 4; i++) counters[i] = 0;
                const prefix = counters.slice(0, idx + 1).join(".");
                const headingText = `${prefix}. ${idx === 0 ? section.heading.toUpperCase() : section.heading}`;
                children.push(
                    new Paragraph({
                        heading: headingLevels[idx],
                        spacing: { after: 160 },
                        children: [new TextRun({ text: headingText, color: "000000", font: FONT, size: SIZE, bold: true })],
                    }),
                );
            }
            if (section.table) {
                const { headers, rows } = section.table;
                const colCount = headers.length;
                const tableRows: InstanceType<typeof TableRow>[] = [];
                // Header row
                tableRows.push(
                    new TableRow({
                        tableHeader: true,
                        children: headers.map(
                            (h) =>
                                new TableCell({
                                    borders: cellBorder,
                                    shading: { fill: "F2F2F2" },
                                    children: [
                                        new Paragraph({
                                            children: [new TextRun({ text: h, bold: true, font: FONT, size: SIZE })],
                                            alignment: AlignmentType.LEFT,
                                        }),
                                    ],
                                }),
                        ),
                    }),
                );
                // Data rows — normalize each row to exactly colCount cells.
                // LLMs occasionally emit malformed rows (extra fragments from
                // stray delimiters, or short rows); padding/truncating here
                // keeps the rendered table aligned to the headers.
                for (const rawRow of rows) {
                    const row = Array.isArray(rawRow) ? rawRow : [];
                    const normalized: string[] = [];
                    for (let i = 0; i < colCount; i++) {
                        normalized.push(
                            typeof row[i] === "string" ? row[i] : "",
                        );
                    }
                    if (row.length !== colCount) {
                        console.warn(
                            `[generate_docx] row length ${row.length} != headers ${colCount}; normalized`,
                        );
                    }
                    tableRows.push(
                        new TableRow({
                            children: normalized.map(
                                (cell) =>
                                    new TableCell({
                                        borders: cellBorder,
                                        children: [
                                            new Paragraph({
                                                children: [new TextRun({ text: cell, font: FONT, size: SIZE })],
                                            }),
                                        ],
                                    }),
                            ),
                        }),
                    );
                }
                children.push(
                    new Table({
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        rows: tableRows,
                    }),
                );
                children.push(new Paragraph({ text: "" }));
            }
            if (section.content) {
                for (const line of section.content.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    const bulletMatch = trimmed.match(/^[-•*]\s+(.+)/);
                    if (bulletMatch) {
                        children.push(
                            new Paragraph({
                                bullet: { level: 0 },
                                spacing: { after: 120 },
                                children: [new TextRun({ text: bulletMatch[1], font: FONT, size: SIZE })],
                            }),
                        );
                    } else {
                        children.push(
                            new Paragraph({
                                spacing: { after: 120 },
                                children: [new TextRun({ text: trimmed, font: FONT, size: SIZE })],
                            }),
                        );
                    }
                }
            }
        }

        const pageSetup = options?.landscape
            ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
            : {};

        const doc = new Document({ sections: [{ properties: pageSetup, children }] });
        const buf = await Packer.toBuffer(doc);
        const safeTitle =
            title
                .replace(/[^a-zA-Z0-9 -]/g, "")
                .trim()
                .slice(0, 64) || "document";
        const filename = `${safeTitle}.docx`;
        const generatedBytes = buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer;

        // Persist to DB so generated docs are first-class documents:
        // openable in the DocPanel and editable via edit_document. In
        // project chats we attach to the project so it appears in the
        // sidebar; in the general chat we leave project_id null and it
        // stays a standalone document.
        const { data: docRow, error: docErr } = await db
            .from("documents")
            .insert({
                project_id: options?.projectId ?? null,
                user_id: userId,
                filename,
                file_type: "docx",
                size_bytes: buf.byteLength,
                status: "ready",
            })
            .select("id")
            .single();
        if (docErr || !docRow) {
            return {
                error: `Failed to record generated document: ${docErr?.message ?? "unknown"}`,
            };
        }
        const documentId = docRow.id as string;
        let key = generatedDocKey(userId, documentId, filename);
        const contentType =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

        try {
            key = await uploadFile(key, generatedBytes, contentType, {
                db,
                userId,
                projectId: options?.projectId ?? null,
                documentId,
                filename,
                role: "source",
                autoIndex: true,
            });
        } catch (err) {
            await db.from("documents").update({ status: "error" }).eq("id", documentId);
            return { error: `Failed to store generated document: ${String(err)}` };
        }
        const downloadUrl = buildDownloadUrl(key, filename);

        const { data: versionRow, error: verErr } = await db
            .from("document_versions")
            .insert({
                document_id: documentId,
                storage_path: key,
                source: "generated",
                version_number: 1,
                display_name: filename,
            })
            .select("id")
            .single();
        if (verErr || !versionRow) {
            return {
                error: `Failed to record generated document version: ${verErr?.message ?? "unknown"}`,
            };
        }
        const versionId = versionRow.id as string;

        await db
            .from("documents")
            .update({ current_version_id: versionId })
            .eq("id", documentId);

        void syncDocumentVersionToCase({
            documentId,
            versionId,
            userId,
            projectId: options?.projectId ?? null,
            filename,
            contentType,
            bytes: generatedBytes,
            db,
        }).catch((err) => console.error("[case-sync] generated doc failed", err));

        return {
            filename,
            download_url: downloadUrl,
            document_id: documentId,
            version_id: versionId,
            version_number: 1,
            storage_path: key,
            message: `Document '${filename}' has been generated successfully.`,
        };
    } catch (e) {
        return { error: String(e) };
    }
}

// ---------------------------------------------------------------------------
// Document version helpers (DOCX tracked-change editing)
// ---------------------------------------------------------------------------

/**
 * Resolve the current .docx bytes for a document, preferring the active
 * tracked-changes version if one exists, else the original upload.
 */
export async function loadCurrentVersionBytes(
    documentId: string,
    db: ReturnType<typeof createServerDb>,
): Promise<{ bytes: Buffer; storage_path: string } | null> {
    const active = await loadActiveVersion(documentId, db);
    if (!active) return null;
    const raw = await downloadFile(active.storage_path, { db });
    if (!raw) return null;
    return { bytes: Buffer.from(raw), storage_path: active.storage_path };
}

/**
 * Ensure the document has a document_versions row for the current upload.
 * Called before writing the first 'assistant_edit' row so the history is
 * complete. Idempotent.
 */
export async function runEditDocument(params: {
    documentId: string;
    userId: string;
    edits: EditInput[];
    db: ReturnType<typeof createServerDb>;
    /**
     * If provided, append these edits to the existing turn-scoped version
     * (overwrites the file at storagePath and reuses the document_versions
     * row) instead of creating a new version. Used to collapse multiple
     * edit_document tool calls within a single assistant turn into one
     * version.
     */
    reuseVersion?: {
        versionId: string;
        versionNumber: number;
        storagePath: string;
    };
}): Promise<
    | {
          ok: true;
          version_id: string;
          version_number: number;
          storage_path: string;
          download_url: string;
          annotations: EditAnnotation[];
          errors: { index: number; reason: string }[];
      }
    | { ok: false; error: string }
> {
    const { documentId, userId, edits, db, reuseVersion } = params;

    const { data: doc } = await db
        .from("documents")
        .select("id, filename, project_id")
        .eq("id", documentId)
        .single();
    if (!doc) return { ok: false, error: "Document not found." };

    const current = await loadCurrentVersionBytes(documentId, db);
    if (!current) return { ok: false, error: "Could not load document bytes." };

    const { bytes: editedBytes, changes, errors } = await applyTrackedEdits(
        current.bytes,
        edits,
        { author: "Mike" },
    );

    if (changes.length === 0) {
        return {
            ok: false,
            error:
                errors[0]?.reason ??
                "No edits could be applied. Refine context_before/context_after and retry.",
        };
    }

    const ab = editedBytes.buffer.slice(
        editedBytes.byteOffset,
        editedBytes.byteOffset + editedBytes.byteLength,
    ) as ArrayBuffer;

    let versionRowId: string;
    let newPath: string;
    let nextVersionNumber: number;

    if (reuseVersion) {
        // Overwrite the existing turn version's file in place. The version
        // row, version_number, and current_version_id all already point here.
        newPath = reuseVersion.storagePath;
        versionRowId = reuseVersion.versionId;
        nextVersionNumber = reuseVersion.versionNumber;
        newPath = await uploadFile(
            newPath,
            ab,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            {
                db,
                userId,
                projectId: (doc.project_id as string | null) ?? null,
                documentId,
                versionId: versionRowId,
                filename: doc.filename as string,
                role: "source",
                autoIndex: true,
            },
        );
        if (newPath !== reuseVersion.storagePath) {
            await db
                .from("document_versions")
                .update({ storage_path: newPath, updated_at: new Date().toISOString() })
                .eq("id", versionRowId);
        }
    } else {
        const versionId = crypto.randomUUID().replace(/-/g, "");
        newPath = `documents/${userId}/${documentId}/edits/${versionId}.docx`;
        newPath = await uploadFile(
            newPath,
            ab,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            {
                db,
                userId,
                projectId: (doc.project_id as string | null) ?? null,
                documentId,
                filename: doc.filename as string,
                role: "source",
                autoIndex: true,
            },
        );

        // Per-document sequential number for the new assistant_edit
        // version. The counter spans upload + user_upload + assistant_edit
        // so the original upload is V1 and the first assistant edit is V2.
        const { data: maxRow } = await db
            .from("document_versions")
            .select("version_number")
            .eq("document_id", documentId)
            .in("source", ["upload", "user_upload", "assistant_edit"])
            .order("version_number", { ascending: false, nullsFirst: false })
            .limit(1)
            .maybeSingle();
        nextVersionNumber = ((maxRow?.version_number as number | null) ?? 1) + 1;

        // Inherit the display name from the most recent prior version so
        // user-applied renames carry forward through further edits. Falls
        // back to the parent document's filename when no prior version has
        // a display name (e.g. the first assistant edit of a pre-existing
        // doc). We intentionally do NOT append "[Edited Vn]" — the version
        // number is surfaced separately as a tag in the UI.
        const { data: prevRow } = await db
            .from("document_versions")
            .select("display_name, created_at")
            .eq("document_id", documentId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        const inheritedDisplayName =
            (prevRow?.display_name as string | null) ??
            (doc.filename as string | null) ??
            null;

        const { data: versionRow, error: verErr } = await db
            .from("document_versions")
            .insert({
                document_id: documentId,
                storage_path: newPath,
                source: "assistant_edit",
                version_number: nextVersionNumber,
                display_name: inheritedDisplayName,
            })
            .select("id")
            .single();
        if (verErr || !versionRow) {
            return { ok: false, error: "Failed to record document version." };
        }
        versionRowId = versionRow.id as string;
    }

    // Insert one row per change
    const editRows = changes.map((c) => ({
        document_id: documentId,
        version_id: versionRowId,
        change_id: c.id,
        del_w_id: c.delId ?? null,
        ins_w_id: c.insId ?? null,
        deleted_text: c.deletedText,
        inserted_text: c.insertedText,
        context_before: c.contextBefore ?? "",
        context_after: c.contextAfter ?? "",
        status: "pending" as const,
    }));
    const { data: insertedEdits, error: editsErr } = await db
        .from("document_edits")
        .insert(editRows)
        .select("id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, context_before, context_after");

    if (editsErr || !insertedEdits) {
        return { ok: false, error: "Failed to record edits." };
    }

    await db
        .from("documents")
        .update({ current_version_id: versionRowId })
        .eq("id", documentId);

    void syncDocumentVersionToCase({
        documentId,
        versionId: versionRowId,
        userId,
        projectId: (doc.project_id as string | null) ?? null,
        filename: doc.filename as string,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: ab,
        db,
    }).catch((err) => console.error("[case-sync] edited document failed", err));

    const annotations: EditAnnotation[] = insertedEdits.map((r: { id: string; change_id: string; deleted_text: string; inserted_text: string; context_before: string | null; context_after: string | null }) => {
        const src = changes.find((c) => c.id === r.change_id);
        return {
            kind: "edit",
            edit_id: r.id,
            document_id: documentId,
            version_id: versionRowId,
            version_number: nextVersionNumber,
            change_id: r.change_id,
            del_w_id: src?.delId,
            ins_w_id: src?.insId,
            deleted_text: r.deleted_text ?? "",
            inserted_text: r.inserted_text ?? "",
            context_before: r.context_before ?? "",
            context_after: r.context_after ?? "",
            reason: src?.reason,
            status: "pending",
        };
    });

    // Persistent, non-expiring permalink. The backend streams fresh bytes
    // on each request, so this URL stays valid as long as the file exists.
    const permalink = buildDownloadUrl(newPath, doc.filename as string);

    return {
        ok: true,
        version_id: versionRowId,
        version_number: nextVersionNumber,
        storage_path: newPath,
        download_url: permalink,
        annotations,
        errors,
    };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function readDocumentContent(
    docLabel: string,
    docStore: DocStore,
    write: (s: string) => void,
    docIndex?: DocIndex,
    db?: ReturnType<typeof createServerDb>,
    opts?: { emitEvents?: boolean },
): Promise<string> {
    const emitEvents = opts?.emitEvents ?? true;
    console.log(`[read_document] called with docLabel="${docLabel}"`);
    const docInfo = docStore.get(docLabel);
    if (!docInfo) {
        console.log(
            `[read_document] MISS — docLabel "${docLabel}" not in docStore. Known labels:`,
            Array.from(docStore.keys()),
        );
        return "Document not found.";
    }
    console.log(
        `[read_document] docInfo: filename="${docInfo.filename}", file_type="${docInfo.file_type}", storage_path="${docInfo.storage_path}"`,
    );

    const documentId = docIndex?.[docLabel]?.document_id;
    const emitDocRead = () => {
        if (!emitEvents) return;
        write(
            `data: ${JSON.stringify({
                type: "doc_read",
                filename: docInfo.filename,
                document_id: documentId,
            })}\n\n`,
        );
    };
    if (emitEvents)
        write(
            `data: ${JSON.stringify({
                type: "doc_read_start",
                filename: docInfo.filename,
                document_id: documentId,
            })}\n\n`,
        );
    try {
        if (documentId && db) {
            const caseText = await getCaseTextForDocument({
                documentId,
                versionId: docIndex?.[docLabel]?.version_id ?? null,
                db,
            });
            if (caseText) {
                console.log(
                    `[read_document] using Case.dev extracted text length=${caseText.length} for filename="${docInfo.filename}"`,
                );
                emitDocRead();
                return caseText;
            }
        }

        // Prefer the current tracked-changes version (if any) so read_document
        // reflects accepted/pending edits rather than the original upload.
        let raw: ArrayBuffer | null = null;
        let sourcePath = docInfo.storage_path;
        if (documentId && db) {
            const current = await loadCurrentVersionBytes(documentId, db);
            if (current) {
                raw = current.bytes.buffer.slice(
                    current.bytes.byteOffset,
                    current.bytes.byteOffset + current.bytes.byteLength,
                ) as ArrayBuffer;
                sourcePath = current.storage_path;
                console.log(
                    `[read_document] using current version path="${sourcePath}" (bytes=${raw.byteLength})`,
                );
            } else {
                console.log(
                    `[read_document] loadCurrentVersionBytes returned null for documentId="${documentId}", falling back to original storage_path`,
                );
            }
        }
        if (!raw) {
            raw = await downloadFile(docInfo.storage_path, db ? { db } : undefined);
            if (raw) {
                console.log(
                    `[read_document] fallback download from storage_path="${docInfo.storage_path}" (bytes=${raw.byteLength})`,
                );
            }
        }
        if (!raw) {
            console.log(
                `[read_document] FAILED to download any bytes for docLabel="${docLabel}" (tried path="${sourcePath}")`,
            );
            emitDocRead();
            return "Document could not be read.";
        }
        // Log the first 8 bytes so we can identify real file format regardless
        // of the declared file_type. Valid .docx starts with "PK\x03\x04"
        // (zip). Legacy .doc starts with "\xD0\xCF\x11\xE0" (OLE/CFB).
        // %PDF-1 is a PDF even if mislabeled. Truncated uploads show as all-zero.
        {
            const head = Buffer.from(raw).subarray(0, 8);
            const hex = head.toString("hex");
            const ascii = head
                .toString("binary")
                .replace(/[^\x20-\x7e]/g, ".");
            console.log(
                `[read_document] magic bytes hex=${hex} ascii="${ascii}" for filename="${docInfo.filename}"`,
            );
        }
        let text: string;
        if (docInfo.file_type === "pdf") {
            text = await extractPdfText(raw);
            console.log(
                `[read_document] pdf extracted length=${text.length} for filename="${docInfo.filename}"`,
            );
        } else if (docInfo.file_type === "docx") {
            // Use the same flattening as the edit_document matcher so the
            // LLM sees exactly the characters it can anchor against.
            text = await extractDocxBodyText(Buffer.from(raw));
            console.log(
                `[read_document] docx extractDocxBodyText length=${text.length} for filename="${docInfo.filename}"`,
            );
            if (!text) {
                console.log(
                    `[read_document] docx accepted-view extractor returned empty, falling back to mammoth for filename="${docInfo.filename}"`,
                );
                const mammoth = await import("mammoth");
                const result = await mammoth.extractRawText({
                    buffer: Buffer.from(raw),
                });
                text = result.value;
                console.log(
                    `[read_document] docx mammoth fallback length=${text.length} for filename="${docInfo.filename}"`,
                );
            }
        } else {
            console.log(
                `[read_document] unknown file_type="${docInfo.file_type}" for filename="${docInfo.filename}", trying mammoth`,
            );
            const mammoth = await import("mammoth");
            const result = await mammoth.extractRawText({
                buffer: Buffer.from(raw),
            });
            text = result.value;
            console.log(
                `[read_document] mammoth length=${text.length} for filename="${docInfo.filename}"`,
            );
        }
        console.log(
            `[read_document] DONE filename="${docInfo.filename}" finalTextLength=${text.length} firstChars=${JSON.stringify(text.slice(0, 120))}`,
        );
        emitDocRead();
        return text;
    } catch (err) {
        console.log(
            `[read_document] THREW for docLabel="${docLabel}" filename="${docInfo.filename}":`,
            err,
        );
        if (emitEvents)
            write(`data: ${JSON.stringify({ type: "doc_read", filename: docInfo.filename })}\n\n`);
        return "Document could not be read.";
    }
}

/**
 * Build a whitespace-collapsed, lowercased copy of `text`, plus a map from
 * each character index in the normalized form back to the corresponding
 * index in the original text. Used by `findInDocumentContent` so matches
 * are tolerant of case + whitespace variance but can still return the
 * exact original excerpt.
 */
function normalizeWithMap(text: string): { norm: string; origIdx: number[] } {
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch.toLowerCase());
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

function normalizeQuery(q: string): string {
    return q.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Ctrl+F helper. Returns a JSON-serializable result with up to `maxResults`
 * hits, each containing the original-text excerpt plus surrounding context.
 */
async function findInDocumentContent(params: {
    docLabel: string;
    query: string;
    maxResults?: number;
    contextChars?: number;
    docStore: DocStore;
    write: (s: string) => void;
    docIndex?: DocIndex;
    db?: ReturnType<typeof createServerDb>;
}): Promise<string> {
    const {
        docLabel,
        query,
        maxResults = 20,
        contextChars = 80,
        docStore,
        write,
        docIndex,
        db,
    } = params;

    if (!query || !query.trim()) {
        return JSON.stringify({ ok: false, error: "Empty query." });
    }

    const docInfo = docStore.get(docLabel);
    if (!docInfo) {
        return JSON.stringify({
            ok: false,
            error: `Document '${docLabel}' not found.`,
        });
    }

    // Announce the search to the UI, then reuse readDocumentContent for its
    // fallbacks — but suppress its own doc_read events so the user only sees
    // the doc_find block (not a competing doc_read block for the same op).
    write(
        `data: ${JSON.stringify({
            type: "doc_find_start",
            filename: docInfo.filename,
            query,
        })}\n\n`,
    );

    const text = await readDocumentContent(
        docLabel,
        docStore,
        write,
        docIndex,
        db,
        { emitEvents: false },
    );
    if (!text || text === "Document could not be read.") {
        write(
            `data: ${JSON.stringify({
                type: "doc_find",
                filename: docInfo.filename,
                query,
                total_matches: 0,
            })}\n\n`,
        );
        return JSON.stringify({
            ok: false,
            filename: docInfo.filename,
            error: "Document could not be read.",
        });
    }

    const { norm, origIdx } = normalizeWithMap(text);
    const needle = normalizeQuery(query);
    if (!needle) {
        return JSON.stringify({ ok: false, error: "Empty query after normalization." });
    }

    type Hit = {
        index: number;
        excerpt: string;
        context: string;
    };
    const hits: Hit[] = [];
    let from = 0;
    while (from <= norm.length - needle.length && hits.length < maxResults) {
        const pos = norm.indexOf(needle, from);
        if (pos < 0) break;
        const endNormPos = pos + needle.length;
        const origStart = origIdx[pos] ?? 0;
        const origEnd =
            endNormPos - 1 < origIdx.length
                ? origIdx[endNormPos - 1] + 1
                : text.length;
        const ctxStart = Math.max(0, origStart - contextChars);
        const ctxEnd = Math.min(text.length, origEnd + contextChars);
        hits.push({
            index: hits.length,
            excerpt: text.slice(origStart, origEnd),
            context:
                (ctxStart > 0 ? "…" : "") +
                text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
                (ctxEnd < text.length ? "…" : ""),
        });
        from = pos + Math.max(1, needle.length);
    }

    // Count total occurrences beyond the cap so the model knows whether to narrow the query.
    let totalMatches = hits.length;
    if (hits.length >= maxResults) {
        let probe = from;
        while (probe <= norm.length - needle.length) {
            const pos = norm.indexOf(needle, probe);
            if (pos < 0) break;
            totalMatches++;
            probe = pos + Math.max(1, needle.length);
        }
    }

    write(
        `data: ${JSON.stringify({
            type: "doc_find",
            filename: docInfo.filename,
            query,
            total_matches: totalMatches,
        })}\n\n`,
    );

    return JSON.stringify({
        ok: true,
        filename: docInfo.filename,
        query,
        total_matches: totalMatches,
        returned: hits.length,
        truncated: totalMatches > hits.length,
        hits,
    });
}

type ChatSkillSummary = ReturnType<typeof summarizeSkill> & {
    imported_workflow?: {
        workflow_id: string;
        title: string;
        synced_at?: string | null;
    };
};

function workflowSkillSummary(
    workflowId: string,
    workflow: WorkflowStore extends Map<string, infer T> ? T : never,
): ChatSkillSummary | null {
    if (!workflow.case_skill_slug) return null;
    return {
        slug: workflow.case_skill_slug,
        name: workflow.case_skill_name ?? workflow.title,
        summary: workflow.case_skill_summary ?? null,
        tags: normalizeSkillTags(workflow.case_skill_tags),
        score: null,
        source:
            workflow.case_skill_source === "custom" ||
            workflow.case_skill_source === "curated"
                ? workflow.case_skill_source
                : null,
        version:
            workflow.case_skill_version === undefined ||
            workflow.case_skill_version === null
                ? null
                : String(workflow.case_skill_version),
        author_name: null,
        license: null,
        imported_workflow: {
            workflow_id: workflowId,
            title: workflow.title,
            synced_at: workflow.case_skill_synced_at ?? null,
        },
    };
}

function skillMatchesQuery(skill: ChatSkillSummary, query: string) {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
        skill.slug.toLowerCase().includes(q) ||
        skill.name.toLowerCase().includes(q) ||
        (skill.summary ?? "").toLowerCase().includes(q) ||
        skill.tags.some((tag) => tag.toLowerCase().includes(q))
    );
}

function importedCaseSkillSummaries(
    workflowStore: WorkflowStore | undefined,
    query: string,
): ChatSkillSummary[] {
    if (!workflowStore) return [];
    return Array.from(workflowStore.entries())
        .map(([id, workflow]) => workflowSkillSummary(id, workflow))
        .filter((skill): skill is ChatSkillSummary => !!skill)
        .filter((skill) => skillMatchesQuery(skill, query));
}

function importedWorkflowForSkill(
    workflowStore: WorkflowStore | undefined,
    slug: string,
): ChatSkillSummary["imported_workflow"] | undefined {
    return importedCaseSkillSummaries(workflowStore, "").find(
        (skill) => skill.slug === slug,
    )?.imported_workflow;
}

function mergeSkillSummaries(...lists: ChatSkillSummary[][]): ChatSkillSummary[] {
    const bySlug = new Map<string, ChatSkillSummary>();
    for (const list of lists) {
        for (const skill of list) {
            const existing = bySlug.get(skill.slug);
            bySlug.set(skill.slug, {
                ...existing,
                ...skill,
                imported_workflow:
                    existing?.imported_workflow ?? skill.imported_workflow,
                tags: skill.tags.length ? skill.tags : (existing?.tags ?? []),
                summary: skill.summary ?? existing?.summary ?? null,
                score: skill.score ?? existing?.score ?? null,
            });
        }
    }
    return Array.from(bySlug.values());
}

export type DocEditedResult = {
    filename: string;
    document_id: string;
    version_id: string;
    version_number: number | null;
    download_url: string;
    annotations: EditAnnotation[];
};

export type TurnEditState = Map<
    string,
    { versionId: string; versionNumber: number; storagePath: string }
>;

export type DocCreatedResult = {
    filename: string;
    download_url: string;
    document_id?: string;
    version_id?: string;
    version_number?: number | null;
};

export type DocReplicatedResult = {
    /** Filename of the source document being copied. */
    filename: string;
    /** How many copies were produced in this single tool call. */
    count: number;
    /** One entry per new copy. */
    copies: {
        new_filename: string;
        document_id: string;
        version_id: string;
    }[];
};

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, max = 10): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value
        .map((item) => optionalString(item))
        .filter((item): item is string => Boolean(item))
        .slice(0, max);
    return items.length ? items : undefined;
}

function clampedInteger(
    value: unknown,
    fallback: number | undefined,
    min: number,
    max: number,
): number | undefined {
    const raw = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(raw)));
}

function caseLegalError(err: unknown): Record<string, unknown> {
    if (err instanceof CaseApiError) {
        const message =
            err.status === 401
                ? "Case.dev API key is invalid or expired."
                : err.status === 403
                  ? "Case.dev API key does not include Legal API permission."
                  : `Case.dev Legal API request failed with status ${err.status}.`;
        return {
            ok: false,
            error: message,
            status: err.status,
            detail: err.body ? err.body.slice(0, 500) : undefined,
        };
    }
    return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
    };
}

async function runCaseLegalRequest(
    userId: string,
    db: ReturnType<typeof createServerDb>,
    request: (client: CaseClient) => Promise<unknown>,
): Promise<Record<string, unknown>> {
    const effective = await getEffectiveCaseApiKey(userId, db).catch((err) => {
        console.error("[case-legal] failed to resolve Case key", err);
        return null;
    });
    if (!effective) {
        return {
            ok: false,
            error:
                "A verified Case.dev API key with Legal API permission is required for legal research.",
        };
    }
    try {
        return {
            ok: true,
            key_source: effective.source,
            result: await request(
                caseClientForEffectiveKey(effective, {
                    userId,
                    db,
                    service: "legal",
                    operation: "legal.research",
                }),
            ),
        };
    } catch (err) {
        return caseLegalError(err);
    }
}

export async function runToolCalls(
    toolCalls: ToolCall[],
    docStore: DocStore,
    userId: string,
    db: ReturnType<typeof createServerDb>,
    write: (s: string) => void,
    workflowStore?: WorkflowStore,
    tabularStore?: TabularCellStore,
    docIndex?: DocIndex,
    turnEditState?: TurnEditState,
    projectId?: string | null,
): Promise<{
    toolResults: unknown[];
    docsRead: { filename: string; document_id?: string }[];
    docsFound: { filename: string; query: string; total_matches: number }[];
    docsCreated: DocCreatedResult[];
    docsReplicated: DocReplicatedResult[];
    workflowsApplied: { workflow_id: string; title: string }[];
    docsEdited: DocEditedResult[];
}> {
    const toolResults: unknown[] = [];
    const docsRead: { filename: string; document_id?: string }[] = [];
    const docsFound: {
        filename: string;
        query: string;
        total_matches: number;
    }[] = [];
    const docsCreated: DocCreatedResult[] = [];
    const docsReplicated: DocReplicatedResult[] = [];
    const workflowsApplied: { workflow_id: string; title: string }[] = [];
    const docsEdited: DocEditedResult[] = [];

    for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
            args = JSON.parse(tc.function.arguments || "{}");
        } catch {
            /* ignore */
        }

        if (tc.function.name === "list_vault_documents") {
            const requested = Array.isArray(args.doc_ids)
                ? (args.doc_ids as unknown[]).map((id) => String(id))
                : [];
            const labels = requested.length
                ? requested.map((id) => resolveDocLabel(id, docStore, docIndex) ?? id)
                : Object.keys(docIndex ?? {});
            const documentIds = labels
                .map((label) => docIndex?.[label]?.document_id)
                .filter((id): id is string => typeof id === "string");
            const labelByDocumentId = new Map<string, string>();
            for (const [label, info] of Object.entries(docIndex ?? {})) {
                labelByDocumentId.set(info.document_id, label);
            }
            const documents = await listCaseVaultDocuments({
                documentIds,
                projectId,
                labelByDocumentId,
                db,
            });
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify({
                    count: documents.length,
                    documents,
                    note:
                        documents.length === 0
                            ? "No Case.dev Vault-linked documents are available in this scope."
                            : undefined,
                }),
            });

        } else if (tc.function.name === "read_document") {
            const rawDocId = args.doc_id as string;
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const content = await readDocumentContent(docId, docStore, write, docIndex, db);
            const filename = docStore.get(docId)?.filename;
            const documentId = docIndex?.[docId]?.document_id;
            if (filename) docsRead.push({ filename, document_id: documentId });
            toolResults.push({ role: "tool", tool_call_id: tc.id, content });

        } else if (tc.function.name === "search_documents") {
            const query = String(args.query ?? "").trim();
            const requested = Array.isArray(args.doc_ids)
                ? (args.doc_ids as unknown[]).map((id) => String(id))
                : [];
            const topK =
                typeof args.top_k === "number"
                    ? Math.max(1, Math.min(50, Math.floor(args.top_k)))
                    : 10;
            const method =
                args.method === "fast" ||
                args.method === "local" ||
                args.method === "global" ||
                args.method === "entity" ||
                args.method === "hybrid"
                    ? (args.method as CaseVaultSearchMethod)
                    : "hybrid";
            const labels = requested.length
                ? requested.map((id) => resolveDocLabel(id, docStore, docIndex) ?? id)
                : Object.keys(docIndex ?? {});
            const documentIds = labels
                .map((label) => docIndex?.[label]?.document_id)
                .filter((id): id is string => typeof id === "string");

            write(
                `data: ${JSON.stringify({
                    type: "doc_read_start",
                    filename: requested.length
                        ? `Searching ${requested.length} document${requested.length === 1 ? "" : "s"}`
                        : "Searching documents",
                })}\n\n`,
            );

            const search = query
                ? await searchCaseDocuments({
                      query,
                      documentIds,
                      projectId,
                      topK,
                      method,
                      db,
                  })
                : { hits: [], searched_object_count: 0, method };
            const labelByDocumentId = new Map<string, string>();
            for (const [label, info] of Object.entries(docIndex ?? {})) {
                labelByDocumentId.set(info.document_id, label);
            }
            const chunks = search.hits.map((hit) => ({
                doc_id: labelByDocumentId.get(hit.document_id) ?? null,
                document_id: hit.document_id,
                filename: hit.filename,
                page_start: hit.page_start,
                page_end: hit.page_end,
                chunk_index: hit.chunk_index,
                case_vault_id: hit.case_vault_id,
                case_object_id: hit.case_object_id,
                score: hit.score,
                preview_text: hit.preview_text,
                text: hit.text,
                surrounding_chunks: hit.surrounding_chunks,
            }));
            write(
                `data: ${JSON.stringify({
                    type: "doc_read",
                    filename: "Case.dev document search",
                })}\n\n`,
            );
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify({
                    query,
                    method,
                    count: chunks.length,
                    searched_object_count: search.searched_object_count,
                    response: search.response ?? null,
                    sources: search.sources ?? [],
                    chunks,
                    note:
                        chunks.length === 0
                            ? search.skipped_reason ??
                              "No Case.dev-indexed matches were found. Use read_document or find_in_document as a fallback."
                            : undefined,
                }),
            });

        } else if (tc.function.name === "get_document_context") {
            const rawDocId = String(args.doc_id ?? "");
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const chunkIndex =
                typeof args.chunk_index === "number"
                    ? Math.max(0, Math.floor(args.chunk_index))
                    : 0;
            const documentId = docIndex?.[docId]?.document_id;
            if (!documentId) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error: `Document '${rawDocId}' not found.`,
                    }),
                });
            } else {
                const context = await getCaseDocumentContext({
                    documentId,
                    versionId: docIndex?.[docId]?.version_id ?? null,
                    chunkIndex,
                    before:
                        typeof args.before === "number"
                            ? Math.floor(args.before)
                            : undefined,
                    after:
                        typeof args.after === "number"
                            ? Math.floor(args.after)
                            : undefined,
                    db,
                });
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        doc_id: docId,
                        ...context,
                    }),
                });
            }

        } else if (tc.function.name === "find_in_document") {
            const rawDocId = args.doc_id as string;
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const query = (args.query as string) ?? "";
            const maxResults = typeof args.max_results === "number" ? args.max_results : undefined;
            const contextChars = typeof args.context_chars === "number" ? args.context_chars : undefined;
            const content = await findInDocumentContent({
                docLabel: docId,
                query,
                maxResults,
                contextChars,
                docStore,
                write,
                docIndex,
                db,
            });
            const filename = docStore.get(docId)?.filename;
            if (filename) {
                let totalMatches = 0;
                try {
                    const parsed = JSON.parse(content) as {
                        total_matches?: number;
                    };
                    totalMatches = parsed.total_matches ?? 0;
                } catch {
                    /* ignore — still record the find attempt */
                }
                docsFound.push({
                    filename,
                    query,
                    total_matches: totalMatches,
                });
            }
            toolResults.push({ role: "tool", tool_call_id: tc.id, content });

        } else if (tc.function.name === "list_documents") {
            const list = Array.from(docStore.entries()).map(
                ([doc_id, info]) => ({
                    doc_id,
                    filename: info.filename,
                    file_type: info.file_type,
                }),
            );
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify(list),
            });

        } else if (tc.function.name === "fetch_documents") {
            const rawDocIds = (args.doc_ids as string[]) ?? [];
            const docIds = rawDocIds.map(
                (id) => resolveDocLabel(id, docStore, docIndex) ?? id,
            );
            const parts: string[] = [];
            for (const docId of docIds) {
                const content = await readDocumentContent(docId, docStore, write, docIndex, db);
                const filename = docStore.get(docId)?.filename ?? docId;
                parts.push(`--- ${filename} (${docId}) ---\n${content}`);
                if (docStore.get(docId)) {
                    const documentId = docIndex?.[docId]?.document_id;
                    docsRead.push({ filename, document_id: documentId });
                }
            }
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: parts.join("\n\n"),
            });

        } else if (tc.function.name === "list_workflows") {
            const list = workflowStore
                ? Array.from(workflowStore.entries()).map(([id, w]) => ({
                      id,
                      title: w.title,
                      case_skill_slug: w.case_skill_slug ?? null,
                      case_skill_name: w.case_skill_name ?? null,
                      case_skill_summary: w.case_skill_summary ?? null,
                      case_skill_tags: normalizeSkillTags(w.case_skill_tags),
                  }))
                : [];
            toolResults.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(list) });

        } else if (tc.function.name === "read_workflow") {
            const wfId = args.workflow_id as string;
            const wf = workflowStore?.get(wfId);
            if (wf) {
                write(`data: ${JSON.stringify({ type: "workflow_applied", workflow_id: wfId, title: wf.title })}\n\n`);
                workflowsApplied.push({ workflow_id: wfId, title: wf.title });
            }
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: wf ? wf.prompt_md : `Workflow '${wfId}' not found.`,
            });

        } else if (tc.function.name === "search_case_skills") {
            const query = String(args.query ?? "").trim();
            const source =
                args.source === "case" ||
                args.source === "custom" ||
                args.source === "imported"
                    ? args.source
                    : "all";
            const limit =
                typeof args.limit === "number"
                    ? Math.max(1, Math.min(20, Math.floor(args.limit)))
                    : 10;
            const imported = source === "case"
                ? []
                : importedCaseSkillSummaries(workflowStore, query).filter(
                      (skill) =>
                          source !== "custom" || skill.source === "custom",
                  );
            const liveSkills: ChatSkillSummary[] = [];
            const errors: string[] = [];

            if (source !== "imported") {
                try {
                    const { client, keySource } = await getCaseSkillsClient(userId, db);
                    if (source !== "custom" && query.length >= 2) {
                        const result = await client.searchSkills({
                            query,
                            limit,
                        });
                        liveSkills.push(
                            ...((result.results ?? []).map((skill) => ({
                                ...summarizeSkill(skill),
                                imported_workflow: importedWorkflowForSkill(
                                    workflowStore,
                                    skill.slug,
                                ),
                            })) as ChatSkillSummary[]),
                        );
                    } else if (source !== "custom" && query.length > 0) {
                        errors.push(
                            "Case catalog search requires at least 2 characters; use a more specific query.",
                        );
                    }

                    if (source !== "case") {
                        const custom = await client.listCustomSkills({
                            limit: Math.max(limit, 20),
                        });
                        liveSkills.push(
                            ...((custom.skills ?? [])
                                .map((skill) => ({
                                    ...summarizeSkill(skill),
                                    imported_workflow: importedWorkflowForSkill(
                                        workflowStore,
                                        skill.slug,
                                    ),
                                }))
                                .filter((skill) =>
                                    skillMatchesQuery(skill, query),
                                ) as ChatSkillSummary[]),
                        );
                    }
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            query,
                            source,
                            key_source: keySource,
                            count: mergeSkillSummaries(imported, liveSkills).slice(
                                0,
                                limit,
                            ).length,
                            skills: mergeSkillSummaries(imported, liveSkills).slice(
                                0,
                                limit,
                            ),
                            notes: errors,
                        }),
                    });
                } catch (err: unknown) {
                    const fallback = imported.slice(0, limit);
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            query,
                            source,
                            count: fallback.length,
                            skills: fallback,
                            error:
                                (err as Error).message ||
                                "Failed to search Case.dev skills",
                            note:
                                fallback.length > 0
                                    ? "Returned imported Case-backed workflows only because live Case.dev Skills search was unavailable."
                                    : "Add a Case.dev API key with Skills access in Account > Models.",
                        }),
                    });
                }
            } else {
                const skills = imported.slice(0, limit);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        query,
                        source,
                        count: skills.length,
                        skills,
                    }),
                });
            }

        } else if (tc.function.name === "read_case_skill") {
            const slug = String(args.slug ?? "").trim();
            const imported = importedWorkflowForSkill(workflowStore, slug);
            const importedWorkflow =
                imported?.workflow_id && workflowStore?.has(imported.workflow_id)
                    ? workflowStore.get(imported.workflow_id)
                    : null;

            if (importedWorkflow) {
                try {
                    const { client, keySource } = await getCaseSkillsClient(userId, db);
                    const skill = await client.readSkill(slug);
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            key_source: keySource,
                            skill: serializeSkill(skill),
                            imported_workflow: imported,
                            note:
                                "This skill is already imported as a Mike workflow. Prefer read_workflow with imported_workflow.workflow_id if applying it so Mike workflow overlays are included.",
                        }),
                    });
                } catch (err: unknown) {
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            skill: {
                                slug,
                                name:
                                    importedWorkflow.case_skill_name ??
                                    importedWorkflow.title,
                                summary:
                                    importedWorkflow.case_skill_summary ?? null,
                                tags: normalizeSkillTags(
                                    importedWorkflow.case_skill_tags,
                                ),
                                source:
                                    importedWorkflow.case_skill_source ?? null,
                                version:
                                    importedWorkflow.case_skill_version ?? null,
                                content: importedWorkflow.prompt_md,
                            },
                            imported_workflow: imported,
                            warning:
                                (err as Error).message ||
                                "Live Case.dev skill lookup failed; using the imported workflow snapshot.",
                        }),
                    });
                }
            } else {
                try {
                    const { client, keySource } = await getCaseSkillsClient(userId, db);
                    const skill = await client.readSkill(slug);
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            key_source: keySource,
                            skill: serializeSkill(skill),
                            imported_workflow: null,
                            note:
                                "If the user asked to apply this skill, follow skill.content as the instructions for this turn.",
                        }),
                    });
                } catch (err: unknown) {
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            slug,
                            error:
                                (err as Error).message ||
                                "Failed to read Case.dev skill",
                        }),
                    });
                }
            }

        } else if (tc.function.name === "legal_research") {
            const query = optionalString(args.query);
            const mode = args.mode === "research" ? "research" : "find";
            const numResults = clampedInteger(args.num_results, 10, 1, 25);
            if (!query) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error: "legal_research requires a query.",
                    }),
                });
            } else {
                const content = await runCaseLegalRequest(userId, db, (client) =>
                    mode === "research"
                        ? client.legalDeepResearch({
                              query,
                              additionalQueries: stringArray(
                                  args.additional_queries,
                                  8,
                              ),
                              jurisdiction: optionalString(args.jurisdiction),
                              numResults,
                          })
                        : client.legalFind({
                              query,
                              jurisdiction: optionalString(args.jurisdiction),
                              numResults,
                          }),
                );
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ tool: "legal_research", mode, query, ...content }),
                });
            }

        } else if (tc.function.name === "legal_source_text") {
            const url = optionalString(args.url);
            if (!url) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error: "legal_source_text requires a URL.",
                    }),
                });
            } else {
                const content = await runCaseLegalRequest(userId, db, (client) =>
                    client.legalFullText({
                        url,
                        maxCharacters: clampedInteger(
                            args.max_characters,
                            undefined,
                            500,
                            50000,
                        ),
                        highlightQuery: optionalString(args.highlight_query),
                        summaryQuery: optionalString(args.summary_query),
                    }),
                );
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ tool: "legal_source_text", url, ...content }),
                });
            }

        } else if (tc.function.name === "verify_legal_citations") {
            const text = optionalString(args.text);
            const url = optionalString(args.url);
            const action = args.action === "extract" ? "extract" : "verify";
            if (!text && !url) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error: "verify_legal_citations requires text or url.",
                    }),
                });
            } else {
                const content = await runCaseLegalRequest(userId, db, (client) => {
                    if (url) return client.legalExtractCitationsFromUrl(url);
                    return action === "extract"
                        ? client.legalExtractCitations(text as string)
                        : client.legalVerifyCitations(text as string);
                });
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        tool: "verify_legal_citations",
                        action,
                        input: url ? { url } : { text },
                        note: url
                            ? "URL inputs use Case.dev citation extraction from URL."
                            : undefined,
                        ...content,
                    }),
                });
            }

        } else if (tc.function.name === "find_similar_legal_sources") {
            const url = optionalString(args.url);
            if (!url) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error: "find_similar_legal_sources requires a URL.",
                    }),
                });
            } else {
                const content = await runCaseLegalRequest(userId, db, (client) =>
                    client.legalFindSimilar({
                        url,
                        jurisdiction: optionalString(args.jurisdiction),
                        numResults: clampedInteger(args.num_results, 10, 1, 25),
                        startPublishedDate: optionalString(
                            args.start_published_date,
                        ),
                    }),
                );
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        tool: "find_similar_legal_sources",
                        url,
                        ...content,
                    }),
                });
            }

        } else if (tc.function.name === "legal_dockets") {
            const operation =
                args.operation === "resolve_jurisdiction" ||
                args.operation === "list_courts" ||
                args.operation === "lookup"
                    ? args.operation
                    : "search";
            const content = await runCaseLegalRequest(userId, db, (client) => {
                if (operation === "resolve_jurisdiction") {
                    const name = optionalString(args.name) ?? optionalString(args.query);
                    if (!name) throw new Error("resolve_jurisdiction requires name.");
                    return client.legalResolveJurisdiction(name);
                }
                if (operation === "list_courts") {
                    return client.legalListCourts({
                        query: optionalString(args.query),
                        jurisdiction: optionalString(args.jurisdiction),
                        inUseOnly: true,
                        limit: clampedInteger(args.limit, 50, 1, 100),
                        offset: clampedInteger(args.offset, 0, 0, 10000),
                    });
                }
                if (operation === "lookup") {
                    const docketId = optionalString(args.docket_id);
                    if (!docketId) throw new Error("docket lookup requires docket_id.");
                    return client.legalDocket({
                        type: "lookup",
                        docketId,
                    });
                }
                const query = optionalString(args.query);
                if (!query) throw new Error("docket search requires query.");
                return client.legalDocket({
                    type: "search",
                    query,
                    court: optionalString(args.court),
                    dateFiledAfter: optionalString(args.date_filed_after),
                    dateFiledBefore: optionalString(args.date_filed_before),
                    limit: clampedInteger(args.limit, 25, 1, 100),
                    offset: clampedInteger(args.offset, 0, 0, 10000),
                });
            });
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify({
                    tool: "legal_dockets",
                    operation,
                    live_pacer_fetch: false,
                    docket_entries_requested: false,
                    ...content,
                }),
            });

        } else if (tc.function.name === "legal_sec_filings") {
            const type = args.type === "entity" ? "entity" : "search";
            const query = optionalString(args.query);
            const ticker = optionalString(args.ticker);
            const entity = optionalString(args.entity);
            const cik = optionalString(args.cik);
            if (type === "search" && !query) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error: "SEC filing search requires query.",
                    }),
                });
            } else if (type === "entity" && !ticker && !entity && !cik) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error:
                            "SEC entity lookup requires ticker, entity, or cik.",
                    }),
                });
            } else {
                const content = await runCaseLegalRequest(userId, db, (client) =>
                    client.legalSecFiling({
                        type,
                        query,
                        formTypes: stringArray(args.form_types, 20),
                        ticker,
                        entity,
                        cik,
                        dateAfter: optionalString(args.date_after),
                        dateBefore: optionalString(args.date_before),
                        limit: clampedInteger(args.limit, 25, 1, 100),
                        offset: clampedInteger(args.offset, 0, 0, 10000),
                    }),
                );
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ tool: "legal_sec_filings", type, ...content }),
                });
            }

        } else if (tc.function.name === "legal_patent_search") {
            const query = optionalString(args.query);
            if (!query) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error: "legal_patent_search requires query.",
                    }),
                });
            } else {
                const sortOrder =
                    args.sort_order === "asc" || args.sort_order === "desc"
                        ? args.sort_order
                        : undefined;
                const content = await runCaseLegalRequest(userId, db, (client) =>
                    client.legalPatentSearch({
                        query,
                        applicationStatus: optionalString(
                            args.application_status,
                        ),
                        applicationType: optionalString(args.application_type),
                        assignee: optionalString(args.assignee),
                        inventor: optionalString(args.inventor),
                        filingDateFrom: optionalString(args.filing_date_from),
                        filingDateTo: optionalString(args.filing_date_to),
                        grantDateFrom: optionalString(args.grant_date_from),
                        grantDateTo: optionalString(args.grant_date_to),
                        limit: clampedInteger(args.limit, 25, 1, 100),
                        offset: clampedInteger(args.offset, 0, 0, 10000),
                        sortBy: optionalString(args.sort_by),
                        sortOrder,
                    }),
                );
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ tool: "legal_patent_search", query, ...content }),
                });
            }

        } else if (tc.function.name === "legal_trademark_lookup") {
            const serialNumber = optionalString(args.serial_number);
            const registrationNumber = optionalString(args.registration_number);
            if (!serialNumber && !registrationNumber) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        ok: false,
                        error:
                            "legal_trademark_lookup requires serial_number or registration_number.",
                    }),
                });
            } else {
                const content = await runCaseLegalRequest(userId, db, (client) =>
                    client.legalTrademarkLookup({
                        serialNumber,
                        registrationNumber,
                    }),
                );
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                        tool: "legal_trademark_lookup",
                        serial_number: serialNumber,
                        registration_number: registrationNumber,
                        ...content,
                    }),
                });
            }

        } else if (tc.function.name === "read_table_cells" && tabularStore) {
            const colIndices = args.col_indices as number[] | undefined;
            const rowIndices = args.row_indices as number[] | undefined;

            const filteredCols = colIndices?.length
                ? tabularStore.columns.filter((_, i) => colIndices.includes(i))
                : tabularStore.columns;
            const filteredDocs = rowIndices?.length
                ? tabularStore.documents.filter((_, i) => rowIndices.includes(i))
                : tabularStore.documents;

            const label = `${filteredCols.length} ${filteredCols.length === 1 ? "column" : "columns"} × ${filteredDocs.length} ${filteredDocs.length === 1 ? "row" : "rows"}`;
            write(`data: ${JSON.stringify({ type: "doc_read_start", filename: label })}\n\n`);

            const lines: string[] = [];
            for (const col of filteredCols) {
                const colPos = tabularStore.columns.findIndex((c) => c.index === col.index);
                for (const doc of filteredDocs) {
                    const rowPos = tabularStore.documents.findIndex((d) => d.id === doc.id);
                    const cell = tabularStore.cells.get(`${col.index}:${doc.id}`);
                    lines.push(`[COL:${colPos} "${col.name}" | ROW:${rowPos} "${doc.filename}"]`);
                    if (cell?.summary) {
                        lines.push(`Summary: ${cell.summary}`);
                        if (cell.flag) lines.push(`Flag: ${cell.flag}`);
                        if (cell.reasoning) lines.push(`Reasoning: ${cell.reasoning}`);
                    } else {
                        lines.push(`(not yet generated)`);
                    }
                    lines.push("");
                }
            }

            write(`data: ${JSON.stringify({ type: "doc_read", filename: label })}\n\n`);
            docsRead.push({ filename: label });
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: lines.join("\n") || "No cells found.",
            });

        } else if (tc.function.name === "edit_document" && docIndex) {
            const rawDocId = args.doc_id as string;
            const editsRaw = args.edits as unknown[] | undefined;
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const docInfo = docStore.get(docId);
            const indexed = docIndex?.[docId];

            const emitEditError = (
                filename: string,
                documentId: string,
                error: string,
            ) => {
                // Surface the failure as a failed "Edited" block in the UI
                // (start → done-with-error) so it matches the shape the
                // success/late-failure paths already use.
                write(
                    `data: ${JSON.stringify({
                        type: "doc_edited_start",
                        filename,
                    })}\n\n`,
                );
                write(
                    `data: ${JSON.stringify({
                        type: "doc_edited",
                        filename,
                        document_id: documentId,
                        version_id: "",
                        download_url: "",
                        annotations: [],
                        error,
                    })}\n\n`,
                );
            };

            if (!docInfo || !indexed) {
                const err = `Document '${docId}' not found in this chat's attachments.`;
                emitEditError(docId, indexed?.document_id ?? "", err);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: err }),
                });
            } else if (
                !Array.isArray(editsRaw) ||
                editsRaw.length === 0
            ) {
                const err = "edits array is required and must not be empty.";
                emitEditError(docInfo.filename, indexed.document_id, err);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: err }),
                });
            } else if (docInfo.file_type !== "docx") {
                const err = "edit_document only supports .docx files.";
                emitEditError(docInfo.filename, indexed.document_id, err);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: err }),
                });
            } else {
                write(
                    `data: ${JSON.stringify({
                        type: "doc_edited_start",
                        filename: docInfo.filename,
                    })}\n\n`,
                );
                const edits: EditInput[] = (editsRaw as Record<string, unknown>[]).map(
                    (e) => ({
                        find: String(e.find ?? ""),
                        replace: String(e.replace ?? ""),
                        context_before: String(e.context_before ?? ""),
                        context_after: String(e.context_after ?? ""),
                        reason: e.reason ? String(e.reason) : undefined,
                    }),
                );
                const reuseVersion = turnEditState?.get(indexed.document_id);
                const result = await runEditDocument({
                    documentId: indexed.document_id,
                    userId,
                    edits,
                    db,
                    reuseVersion,
                });

                if (result.ok) {
                    turnEditState?.set(indexed.document_id, {
                        versionId: result.version_id,
                        versionNumber: result.version_number,
                        storagePath: result.storage_path,
                    });
                    // Keep the chat-local doc label pointed at the latest
                    // edited version so any follow-up read_document call in
                    // the same assistant turn reads and cites the same bytes.
                    if (docIndex[docId]) {
                        docIndex[docId] = {
                            ...docIndex[docId],
                            version_id: result.version_id,
                            version_number: result.version_number,
                        };
                    }
                    const currentDocStore = docStore.get(docId);
                    if (currentDocStore) {
                        docStore.set(docId, {
                            ...currentDocStore,
                            storage_path: result.storage_path,
                        });
                    }
                    const payload: DocEditedResult = {
                        filename: docInfo.filename,
                        document_id: indexed.document_id,
                        version_id: result.version_id,
                        version_number: result.version_number,
                        download_url: result.download_url,
                        annotations: result.annotations,
                    };
                    docsEdited.push(payload);
                    write(
                        `data: ${JSON.stringify({
                            type: "doc_edited",
                            ...payload,
                        })}\n\n`,
                    );
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            ok: true,
                            doc_id: docId,
                            document_id: indexed.document_id,
                            version_id: result.version_id,
                            version_number: result.version_number,
                            applied: result.annotations.length,
                            errors: result.errors,
                        }),
                    });
                } else {
                    write(
                        `data: ${JSON.stringify({
                            type: "doc_edited",
                            filename: docInfo.filename,
                            document_id: indexed.document_id,
                            version_id: "",
                            download_url: "",
                            annotations: [],
                            error: result.error,
                        })}\n\n`,
                    );
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            ok: false,
                            error: result.error,
                        }),
                    });
                }
            }

        } else if (tc.function.name === "replicate_document" && docIndex) {
            const rawDocId = args.doc_id as string;
            const requestedFilename =
                typeof args.new_filename === "string" &&
                args.new_filename.trim()
                    ? args.new_filename.trim()
                    : null;
            const requestedCount =
                typeof args.count === "number" && Number.isFinite(args.count)
                    ? Math.max(1, Math.min(20, Math.floor(args.count)))
                    : 1;
            const sourceLabel =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const sourceInfo = docStore.get(sourceLabel);
            const sourceIndexed = docIndex[sourceLabel];
            const sourceFilename = sourceInfo?.filename ?? rawDocId;

            write(
                `data: ${JSON.stringify({
                    type: "doc_replicate_start",
                    filename: sourceFilename,
                    count: requestedCount,
                })}\n\n`,
            );

            const fail = (error: string) => {
                write(
                    `data: ${JSON.stringify({
                        type: "doc_replicated",
                        filename: sourceFilename,
                        count: requestedCount,
                        copies: [],
                        error,
                    })}\n\n`,
                );
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ ok: false, error }),
                });
            };

            if (!sourceInfo || !sourceIndexed) {
                fail(`Document '${rawDocId}' not found in this project.`);
            } else if (!projectId) {
                fail("replicate_document is only available in project chats.");
            } else {
                try {
                    // Pull the active version once — every copy gets the
                    // same starting bytes (with any accepted tracked
                    // changes rolled in), no point re-fetching per copy.
                    const active = await loadActiveVersion(
                        sourceIndexed.document_id,
                        db,
                    );
                    const sourcePath =
                        active?.storage_path ?? sourceInfo.storage_path;
                    const sourcePdfPath = active?.pdf_storage_path ?? null;
                    const raw = await downloadFile(sourcePath, { db });
                    const pdfBytes = sourcePdfPath
                        ? await downloadFile(sourcePdfPath, { db })
                        : null;
                    if (!raw) {
                        fail(
                            "Could not read the source document's bytes from storage.",
                        );
                    } else {
                        // Build N filenames. With count=1 keep the
                        // pre-existing "(copy)" suffix; with count>1 use
                        // numbered "(1)", "(2)" suffixes.
                        const srcExt =
                            sourceInfo.filename.match(/\.[^./\\]+$/)?.[0] ?? "";
                        const baseStem = (() => {
                            if (requestedFilename) {
                                return requestedFilename.replace(
                                    /\.[^./\\]+$/,
                                    "",
                                );
                            }
                            return sourceInfo.filename.replace(
                                /\.[^./\\]+$/,
                                "",
                            );
                        })();
                        const filenames: string[] = [];
                        for (let n = 1; n <= requestedCount; n++) {
                            const suffix =
                                requestedCount === 1
                                    ? requestedFilename
                                        ? ""
                                        : " (copy)"
                                    : ` (${n})`;
                            filenames.push(`${baseStem}${suffix}${srcExt}`);
                        }

                        // Bulk insert N documents in one round-trip.
                        const docRows = filenames.map((fn) => ({
                            project_id: projectId,
                            user_id: userId,
                            filename: fn,
                            file_type: sourceInfo.file_type,
                            size_bytes: raw.byteLength,
                            status: "ready",
                        }));
                        const { data: insertedDocs, error: docErr } = await db
                            .from("documents")
                            .insert(docRows)
                            .select("id, filename");
                        if (docErr || !insertedDocs || insertedDocs.length === 0) {
                            fail(
                                `Failed to record replicated documents: ${docErr?.message ?? "unknown"}`,
                            );
                        } else {
                            // Preserve the request order so each row pairs
                            // with the right filename.
                            const newDocs = insertedDocs as {
                                id: string;
                                filename: string;
                            }[];
                            const contentType =
                                sourceInfo.file_type === "pdf"
                                    ? "application/pdf"
                                    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

                            // Parallel uploads: the doc bytes (and PDF
                            // rendition if any) for every new copy.
                            const uploadJobs: Promise<void>[] = [];
                            const newKeys: string[] = new Array(newDocs.length);
                            const newPdfKeys: (string | null)[] = new Array(newDocs.length).fill(null);
                            for (let idx = 0; idx < newDocs.length; idx++) {
                                const d = newDocs[idx];
                                const key = storageKey(
                                    userId,
                                    d.id,
                                    d.filename,
                                );
                                uploadJobs.push(
                                    uploadFile(key, raw, contentType, {
                                        db,
                                        userId,
                                        projectId,
                                        documentId: d.id,
                                        filename: d.filename,
                                        role: "source",
                                        autoIndex: true,
                                    }).then((uri) => {
                                        newKeys[idx] = uri;
                                    }),
                                );
                                if (pdfBytes) {
                                    if (sourcePdfPath === sourcePath || sourceInfo.file_type === "pdf") {
                                        newPdfKeys[idx] = key;
                                    } else {
                                        const pdfKey = convertedPdfKey(
                                            userId,
                                            d.id,
                                        );
                                        uploadJobs.push(
                                            uploadFile(
                                                pdfKey,
                                                pdfBytes,
                                                "application/pdf",
                                                {
                                                    db,
                                                    userId,
                                                    projectId,
                                                    documentId: d.id,
                                                    filename: `${d.filename.replace(/\.[^/.]+$/, "") || "document"}.pdf`,
                                                    role: "pdf_rendition",
                                                    autoIndex: false,
                                                },
                                            ).then((uri) => {
                                                newPdfKeys[idx] = uri;
                                            }),
                                        );
                                    }
                                }
                            }
                            await Promise.all(uploadJobs);
                            for (let i = 0; i < newPdfKeys.length; i++) {
                                if (newPdfKeys[i] && !newPdfKeys[i]?.startsWith("case://")) {
                                    newPdfKeys[i] = newKeys[i];
                                }
                            }

                            // Bulk insert N versions in one round-trip.
                            const versionRows = newDocs.map((d, idx) => ({
                                document_id: d.id,
                                storage_path: newKeys[idx],
                                pdf_storage_path: newPdfKeys[idx],
                                source: "upload",
                                version_number: 1,
                                display_name: d.filename,
                            }));
                            const { data: insertedVersions, error: verErr } =
                                await db
                                    .from("document_versions")
                                    .insert(versionRows)
                                    .select("id, document_id");
                            if (
                                verErr ||
                                !insertedVersions ||
                                insertedVersions.length !== newDocs.length
                            ) {
                                fail(
                                    `Failed to record replicated document versions: ${verErr?.message ?? "unknown"}`,
                                );
                            } else {
                                const versionByDocId = new Map<string, string>();
                                for (const v of insertedVersions as {
                                    id: string;
                                    document_id: string;
                                }[]) {
                                    versionByDocId.set(v.document_id, v.id);
                                }

                                // current_version_id has to be a per-row
                                // value, so a single UPDATE statement
                                // can't cover all N. Fan out in parallel
                                // instead of sequential awaits.
                                await Promise.all(
                                    newDocs.map((d) =>
                                        db
                                            .from("documents")
                                            .update({
                                                current_version_id:
                                                    versionByDocId.get(d.id),
                                            })
                                            .eq("id", d.id),
                                    ),
                                );

                                // Register every copy under a fresh doc-N
                                // slug so the model can edit/read any of
                                // them in the same turn.
                                const existingLabels = new Set(
                                    Object.keys(docIndex),
                                );
                                let nextLabelIdx = 0;
                                const copies: {
                                    new_filename: string;
                                    document_id: string;
                                    version_id: string;
                                }[] = [];
                                const toolPayloadCopies: {
                                    doc_id: string;
                                    document_id: string;
                                    version_id: string;
                                    filename: string;
                                    download_url: string;
                                }[] = [];
                                for (let idx = 0; idx < newDocs.length; idx++) {
                                    const d = newDocs[idx];
                                    const newKey = newKeys[idx];
                                    const versionId = versionByDocId.get(d.id);
                                    if (!versionId) continue;
                                    void syncDocumentVersionToCase({
                                        documentId: d.id,
                                        versionId,
                                        userId,
                                        projectId,
                                        filename: d.filename,
                                        contentType,
                                        bytes: raw,
                                        db,
                                    }).catch((err) =>
                                        console.error("[case-sync] replicated document failed", err),
                                    );
                                    const newPdfKey = newPdfKeys[idx];
                                    if (newPdfKey && newPdfKey !== newKey) {
                                        void registerCaseStoredObject({
                                            documentId: d.id,
                                            versionId,
                                            userId,
                                            projectId,
                                            storageUri: newPdfKey,
                                            filename: `${d.filename.replace(/\.[^/.]+$/, "") || "document"}.pdf`,
                                            contentType: "application/pdf",
                                            role: "pdf_rendition",
                                            db,
                                        }).catch((err) =>
                                            console.error("[case-sync] replicated PDF link failed", err),
                                        );
                                    }
                                    while (
                                        existingLabels.has(
                                            `doc-${nextLabelIdx}`,
                                        )
                                    )
                                        nextLabelIdx++;
                                    const slug = `doc-${nextLabelIdx}`;
                                    existingLabels.add(slug);
                                    docIndex[slug] = {
                                        document_id: d.id,
                                        filename: d.filename,
                                    };
                                    docStore.set(slug, {
                                        storage_path: newKey,
                                        file_type: sourceInfo.file_type,
                                        filename: d.filename,
                                    });
                                    copies.push({
                                        new_filename: d.filename,
                                        document_id: d.id,
                                        version_id: versionId,
                                    });
                                    toolPayloadCopies.push({
                                        doc_id: slug,
                                        document_id: d.id,
                                        version_id: versionId,
                                        filename: d.filename,
                                        download_url: buildDownloadUrl(
                                            newKey,
                                            d.filename,
                                        ),
                                    });
                                }

                                write(
                                    `data: ${JSON.stringify({
                                        type: "doc_replicated",
                                        filename: sourceFilename,
                                        count: copies.length,
                                        copies,
                                    })}\n\n`,
                                );
                                docsReplicated.push({
                                    filename: sourceFilename,
                                    count: copies.length,
                                    copies,
                                });
                                toolResults.push({
                                    role: "tool",
                                    tool_call_id: tc.id,
                                    content: JSON.stringify({
                                        ok: true,
                                        count: copies.length,
                                        copies: toolPayloadCopies,
                                    }),
                                });
                            }
                        }
                    }
                } catch (e) {
                    fail(`replicate_document failed: ${String(e)}`);
                }
            }

        } else if (tc.function.name === "generate_docx") {
            const title = args.title as string;
            const landscape = !!(args.landscape);
            console.log(`[generate_docx] title="${title}" landscape=${landscape} args.landscape=${args.landscape}`);
            const previewFilename = `${(title.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 64) || "document")}.docx`;
            write(`data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`);
            const result = await generateDocx(
                title,
                args.sections as unknown[],
                userId,
                db,
                { landscape, projectId: projectId ?? null },
            );
            let newDocLabel: string | null = null;
            if ("filename" in result && "download_url" in result) {
                const dlFilename = result.filename as string;
                const dlUrl = result.download_url as string;
                const documentId = (result as { document_id?: string }).document_id;
                const versionId = (result as { version_id?: string }).version_id;
                const versionNumber = (result as { version_number?: number }).version_number ?? null;
                const storagePath = (result as { storage_path?: string }).storage_path;

                // Register the generated doc in the chat context so
                // edit_document (and read_document / find_in_document)
                // can act on it within the same assistant turn. New label
                // is the next free `doc-N` index. Subsequent turns pick
                // it up via the normal attachment/project doc query.
                if (documentId && storagePath && docIndex) {
                    const existingLabels = new Set(Object.keys(docIndex));
                    let i = 0;
                    while (existingLabels.has(`doc-${i}`)) i++;
                    newDocLabel = `doc-${i}`;
                    docIndex[newDocLabel] = {
                        document_id: documentId,
                        filename: dlFilename,
                    };
                    docStore.set(newDocLabel, {
                        storage_path: storagePath,
                        file_type: "docx",
                        filename: dlFilename,
                    });
                }

                write(
                    `data: ${JSON.stringify({
                        type: "doc_created",
                        filename: dlFilename,
                        download_url: dlUrl,
                        document_id: documentId,
                        version_id: versionId,
                        version_number: versionNumber,
                    })}\n\n`,
                );
                docsCreated.push({
                    filename: dlFilename,
                    download_url: dlUrl,
                    document_id: documentId,
                    version_id: versionId,
                    version_number: versionNumber,
                });
            } else {
                write(`data: ${JSON.stringify({ type: "doc_created", filename: previewFilename, download_url: "" })}\n\n`);
            }
            // Surface the chat-local doc label in the tool result so the
            // model can pass it as `doc_id` to edit_document / read_document
            // / find_in_document in the same turn. Without this the model
            // only sees the DB UUID, which isn't valid as a doc_id anchor.
            const toolResultPayload = newDocLabel
                ? { ...(result as Record<string, unknown>), doc_id: newDocLabel }
                : result;
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify(toolResultPayload),
            });
        }
    }

    return {
        toolResults,
        docsRead,
        docsFound,
        docsCreated,
        docsReplicated,
        workflowsApplied,
        docsEdited,
    };
}

// ---------------------------------------------------------------------------
// Citation parsing
// ---------------------------------------------------------------------------

const CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;
const CITATIONS_OPEN_TAG = "<CITATIONS>";

function parseCitations(text: string): ParsedCitation[] {
    const match = text.match(CITATIONS_BLOCK_RE);
    if (!match) return [];
    try {
        const raw = JSON.parse(match[1]);
        if (!Array.isArray(raw)) return [];
        return raw
            .map(normalizeCitation)
            .filter((c): c is ParsedCitation => c !== null);
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// LLM streaming loop
// ---------------------------------------------------------------------------

export type EditAnnotation = {
    kind: "edit";
    edit_id: string;
    document_id: string;
    version_id: string;
    version_number?: number | null;
    change_id: string;
    del_w_id?: string;
    ins_w_id?: string;
    deleted_text: string;
    inserted_text: string;
    context_before: string;
    context_after: string;
    reason?: string;
    status: "pending" | "accepted" | "rejected";
};

type AssistantEvent =
    | { type: "reasoning"; text: string }
    | { type: "doc_read"; filename: string; document_id?: string }
    | {
          type: "doc_find";
          filename: string;
          query: string;
          total_matches: number;
      }
    | {
          type: "doc_created";
          filename: string;
          download_url: string;
          document_id?: string;
          version_id?: string;
          version_number?: number | null;
      }
    | { type: "doc_download"; filename: string; download_url: string }
    | {
          type: "doc_replicated";
          /** Source document being copied. */
          filename: string;
          count: number;
          copies: {
              new_filename: string;
              document_id: string;
              version_id: string;
          }[];
      }
    | { type: "workflow_applied"; workflow_id: string; title: string }
    | {
          type: "doc_edited";
          filename: string;
          document_id: string;
          version_id: string;
          /** Per-document monotonic Vn; null if backend couldn't determine it. */
          version_number: number | null;
          download_url: string;
          annotations: EditAnnotation[];
      }
    | { type: "content"; text: string };

export async function runLLMStream(params: {
    apiMessages: unknown[];
    docStore: DocStore;
    docIndex: DocIndex;
    userId: string;
    db: ReturnType<typeof createServerDb>;
    write: (s: string) => void;
    extraTools?: unknown[];
    workflowStore?: WorkflowStore;
    tabularStore?: TabularCellStore;
    buildCitations?: (fullText: string) => unknown[];
    model?: string;
    apiKeys?: import("./llm").UserApiKeys;
    /**
     * If set, generate_docx will attach created docs to this project so
     * they appear in the project sidebar. Leave null for general chats —
     * generated docs still get persisted, but as standalone documents.
     */
    projectId?: string | null;
}): Promise<{ fullText: string; events: AssistantEvent[] }> {
    const { apiMessages, docStore, docIndex, userId, db, write, extraTools, workflowStore, tabularStore, buildCitations, model, apiKeys, projectId } = params;
    const activeTools = extraTools?.length
        ? [...TOOLS, ...WORKFLOW_TOOLS, ...SKILL_TOOLS, ...LEGAL_TOOLS, ...extraTools]
        : [...TOOLS, ...WORKFLOW_TOOLS, ...SKILL_TOOLS, ...LEGAL_TOOLS];

    // Extract system prompt; pass remaining turns to the adapter as
    // plain user/assistant messages.
    const rawMsgs = apiMessages as { role: string; content: string | null }[];
    const systemPrompt =
        rawMsgs[0]?.role === "system" ? (rawMsgs[0].content ?? "") : "";
    console.log(
        "[runLLMStream] system prompt:\n" +
            "─".repeat(80) +
            "\n" +
            systemPrompt +
            "\n" +
            "─".repeat(80),
    );
    const chatMessages: LlmMessage[] = rawMsgs
        .filter((m) => m.role !== "system")
        .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content ?? "",
        }));

    const events: AssistantEvent[] = [];
    // One assistant turn produces at most one document_versions row per
    // edited doc. `runToolCalls` fires once per tool-call batch; the model
    // may emit multiple batches in a single turn, so this map persists
    // across batches to let subsequent edit_document calls overwrite the
    // turn's existing version instead of creating a new one.
    const turnEditState: TurnEditState = new Map();
    let fullText = "";
    let iterText = "";
    let iterVisibleText = "";
    let iterReasoning = "";
    let visibleTailBuffer = "";
    let citationsOpenSeen = false;

    const streamVisibleContent = (delta: string) => {
        if (!delta) return;
        if (citationsOpenSeen) return;

        const combined = visibleTailBuffer + delta;
        const markerIdx = combined.indexOf(CITATIONS_OPEN_TAG);
        if (markerIdx >= 0) {
            const visible = combined.slice(0, markerIdx);
            if (visible) {
                iterVisibleText += visible;
                write(
                    `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
                );
            }
            visibleTailBuffer = "";
            citationsOpenSeen = true;
            return;
        }

        const keep = Math.min(CITATIONS_OPEN_TAG.length - 1, combined.length);
        const visible = combined.slice(0, combined.length - keep);
        visibleTailBuffer = combined.slice(combined.length - keep);
        if (visible) {
            iterVisibleText += visible;
            write(
                `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
            );
        }
    };

    const flushVisibleTail = () => {
        if (citationsOpenSeen || !visibleTailBuffer) {
            visibleTailBuffer = "";
            return;
        }
        iterVisibleText += visibleTailBuffer;
        write(
            `data: ${JSON.stringify({ type: "content_delta", text: visibleTailBuffer })}\n\n`,
        );
        visibleTailBuffer = "";
    };

    const flushText = () => {
        if (!iterText) return;
        fullText += iterText;
        flushVisibleTail();
        if (iterVisibleText) {
            events.push({ type: "content", text: iterVisibleText });
        }
        iterText = "";
        iterVisibleText = "";
        visibleTailBuffer = "";
        citationsOpenSeen = false;
    };

    const selectedModel = resolveModel(model, DEFAULT_MAIN_MODEL);

    await streamChatWithTools({
        model: selectedModel,
        systemPrompt,
        messages: chatMessages,
        tools: activeTools as OpenAIToolSchema[],
        maxIterations: 10,
        apiKeys,
        enableThinking: true,
        callbacks: {
            onContentDelta: (delta) => {
                iterText += delta;
                streamVisibleContent(delta);
            },
            onReasoningDelta: (delta) => {
                iterReasoning += delta;
                write(
                    `data: ${JSON.stringify({ type: "reasoning_delta", text: delta })}\n\n`,
                );
            },
            onReasoningBlockEnd: () => {
                if (!iterReasoning) return;
                events.push({ type: "reasoning", text: iterReasoning });
                write(
                    `data: ${JSON.stringify({ type: "reasoning_block_end" })}\n\n`,
                );
                iterReasoning = "";
            },
            // Fires after Claude's turn ends with stop_reason=tool_use, before
            // the tool actually runs. Flushes any buffered assistant text so
            // it's emitted in chronological order, then signals the client so
            // it can open a fresh PreResponseWrapper (shows "Working…") while
            // the tool executes — avoids the dead gap between message_stop
            // and the first tool-specific event.
            onToolCallStart: (call) => {
                flushText();
                write(
                    `data: ${JSON.stringify({
                        type: "tool_call_start",
                        name: call.name,
                    })}\n\n`,
                );
            },
        },
        runTools: async (calls) => {
            // Emit any text the model produced before this tool turn so the
            // UI sees it before the tool results stream in.
            flushText();

            const toolCalls: ToolCall[] = calls.map((c) => ({
                id: c.id,
                function: {
                    name: c.name,
                    arguments: JSON.stringify(c.input),
                },
            }));
            const {
                toolResults,
                docsRead,
                docsFound,
                docsCreated,
                docsReplicated,
                workflowsApplied,
                docsEdited,
            } = await runToolCalls(
                    toolCalls,
                    docStore,
                    userId,
                    db,
                    write,
                    workflowStore,
                    tabularStore,
                    docIndex,
                    turnEditState,
                    projectId,
                );
            for (const r of docsRead) {
                events.push({
                    type: "doc_read",
                    filename: r.filename,
                    document_id: r.document_id,
                });
            }
            for (const f of docsFound) {
                events.push({
                    type: "doc_find",
                    filename: f.filename,
                    query: f.query,
                    total_matches: f.total_matches,
                });
            }
            for (const dl of docsCreated) {
                events.push({
                    type: "doc_created",
                    filename: dl.filename,
                    download_url: dl.download_url,
                    document_id: dl.document_id,
                    version_id: dl.version_id,
                    version_number: dl.version_number ?? null,
                });
            }
            for (const r of docsReplicated) {
                events.push({
                    type: "doc_replicated",
                    filename: r.filename,
                    count: r.count,
                    copies: r.copies,
                });
            }
            for (const wf of workflowsApplied) {
                events.push({
                    type: "workflow_applied",
                    workflow_id: wf.workflow_id,
                    title: wf.title,
                });
            }
            for (const e of docsEdited) {
                events.push({
                    type: "doc_edited",
                    filename: e.filename,
                    document_id: e.document_id,
                    version_id: e.version_id,
                    version_number: e.version_number,
                    download_url: e.download_url,
                    annotations: e.annotations,
                });
            }

            // Index alignment would break if any tool branch skips its
            // push (unhandled tool name, disabled store, guard failure).
            // Each tool_result already carries its tool_call_id, so key off
            // that directly — and fall back to an error result for any
            // tool_use that didn't produce one, so Claude's next request
            // has a tool_result for every tool_use it sent.
            const resultByCallId = new Map<string, string>();
            for (const r of toolResults) {
                const row = r as { tool_call_id: string; content?: unknown };
                resultByCallId.set(row.tool_call_id, String(row.content ?? ""));
            }
            return toolCalls.map((c) => ({
                tool_use_id: c.id,
                content:
                    resultByCallId.get(c.id) ??
                    JSON.stringify({
                        error: `Tool '${c.function.name}' is not available.`,
                    }),
            }));
        },
    });

    flushText();

    // Parse and emit citations from <CITATIONS> block
    const citations = buildCitations
        ? buildCitations(fullText)
        : parseCitations(fullText).map((c) => {
              const docInfo = resolveDoc(c.doc_id, docIndex);
              return {
                  ref: c.ref,
                  doc_id: c.doc_id,
                  document_id: docInfo?.document_id,
                  version_id: docInfo?.version_id ?? null,
                  version_number: docInfo?.version_number ?? null,
                  filename: docInfo?.filename ?? c.doc_id,
                  page: c.page,
                  quote: c.quote,
                  case_vault_id: c.case_vault_id ?? null,
                  case_object_id: c.case_object_id ?? null,
                  chunk_index: c.chunk_index ?? null,
                  word_start_index: c.word_start_index ?? null,
                  word_end_index: c.word_end_index ?? null,
              };
          });
    write(`data: ${JSON.stringify({ type: "citations", citations })}\n\n`);
    write("data: [DONE]\n\n");

    return { fullText, events };
}

// ---------------------------------------------------------------------------
// Annotation extraction (for DB save)
// ---------------------------------------------------------------------------

export function extractAnnotations(
    fullText: string,
    docIndex: DocIndex,
    events?: { type: string } & Record<string, unknown>[] | unknown[],
): unknown[] {
    const out: unknown[] = parseCitations(fullText).map((c) => {
        const docInfo = resolveDoc(c.doc_id, docIndex);
        return {
            type: "citation_data",
            ref: c.ref,
            doc_id: c.doc_id,
            document_id: docInfo?.document_id,
            version_id: docInfo?.version_id ?? null,
            version_number: docInfo?.version_number ?? null,
            filename: docInfo?.filename ?? c.doc_id,
            page: c.page,
            quote: c.quote,
            case_vault_id: c.case_vault_id ?? null,
            case_object_id: c.case_object_id ?? null,
            chunk_index: c.chunk_index ?? null,
            word_start_index: c.word_start_index ?? null,
            word_end_index: c.word_end_index ?? null,
        };
    });
    if (Array.isArray(events)) {
        for (const ev of events as { type?: string; annotations?: EditAnnotation[] }[]) {
            if (ev?.type === "doc_edited" && Array.isArray(ev.annotations)) {
                for (const a of ev.annotations) out.push({ ...a, type: "edit_data" });
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Document context builder (from message file attachments)
// ---------------------------------------------------------------------------

export async function buildDocContext(
    messages: ChatMessage[],
    userId: string,
    db: ReturnType<typeof createServerDb>,
    chatId?: string | null,
): Promise<{ docIndex: DocIndex; docStore: DocStore }> {
    const docIndex: DocIndex = {};
    const docStore: DocStore = new Map();

    const documentIds = new Set<string>();
    for (const m of messages) {
        for (const f of m.files ?? []) {
            if (f.document_id) documentIds.add(f.document_id);
        }
    }

    // Also pull in document_ids from prior assistant events in this chat —
    // generated docs (generate_docx) and tracked-change edits (edit_document)
    // aren't attached to user messages as files, so they only live in the
    // assistant's `doc_created` / `doc_edited` events. Without this sweep
    // the model loses access to generated docs after the turn that created
    // them, and can't call edit_document / read_document on them.
    if (chatId) {
        const { data: rows } = await db
            .from("chat_messages")
            .select("content")
            .eq("chat_id", chatId)
            .eq("role", "assistant");
        for (const row of rows ?? []) {
            const content = (row as { content?: unknown }).content;
            if (!Array.isArray(content)) continue;
            for (const ev of content as Record<string, unknown>[]) {
                if (
                    (ev?.type === "doc_created" ||
                        ev?.type === "doc_edited") &&
                    typeof ev.document_id === "string"
                ) {
                    documentIds.add(ev.document_id);
                }
            }
        }
    }

    const ids = [...documentIds];
    if (ids.length > 0) {
        const { data: docs } = await db
            .from("documents")
            .select("id, filename, file_type, current_version_id, status")
            .in("id", ids)
            .eq("user_id", userId)
            .eq("status", "ready");

        const docList = (docs ?? []) as unknown as {
            id: string;
            filename: string;
            file_type: string;
            current_version_id?: string | null;
            active_version_number?: number | null;
            storage_path?: string | null;
        }[];
        await attachActiveVersionPaths(db, docList);
        for (let i = 0; i < docList.length; i++) {
            const doc = docList[i];
            if (!doc.storage_path) continue;
            const docLabel = `doc-${i}`;
            docIndex[docLabel] = {
                document_id: doc.id,
                filename: doc.filename,
                version_id: doc.current_version_id ?? null,
                version_number: doc.active_version_number ?? null,
            };
            docStore.set(docLabel, {
                storage_path: doc.storage_path,
                file_type: doc.file_type,
                filename: doc.filename,
            });
        }
    }

    console.log(
        "[buildDocContext] available docs:",
        Object.entries(docIndex).map(([label, info]) => ({
            label,
            filename: info.filename,
            document_id: info.document_id,
        })),
    );
    return { docIndex, docStore };
}

export async function buildProjectDocContext(
    projectId: string,
    _userId: string,
    db: ReturnType<typeof createServerDb>,
): Promise<{ docIndex: DocIndex; docStore: DocStore; folderPaths: Map<string, string> }> {
    const docIndex: DocIndex = {};
    const docStore: DocStore = new Map();

    const [{ data: docs }, { data: folders }] = await Promise.all([
        db.from("documents")
            .select("id, filename, file_type, current_version_id, status, folder_id")
            .eq("project_id", projectId)
            .eq("status", "ready")
            .order("created_at", { ascending: true }),
        db.from("project_subfolders")
            .select("id, name, parent_folder_id")
            .eq("project_id", projectId),
    ]);
    const docList = (docs ?? []) as unknown as {
        id: string;
        filename: string;
        file_type: string;
        current_version_id?: string | null;
        active_version_number?: number | null;
        folder_id?: string | null;
        storage_path?: string | null;
    }[];
    await attachActiveVersionPaths(db, docList);

    // Build folder id → full path map
    const folderMap = new Map<string, { name: string; parent_folder_id: string | null }>();
    for (const f of folders ?? []) folderMap.set(f.id, { name: f.name, parent_folder_id: f.parent_folder_id });

    function resolvePath(folderId: string | null): string {
        if (!folderId) return "";
        const parts: string[] = [];
        let cur: string | null = folderId;
        while (cur) {
            const f = folderMap.get(cur);
            if (!f) break;
            parts.unshift(f.name);
            cur = f.parent_folder_id;
        }
        return parts.join(" / ");
    }

    const folderPaths = new Map<string, string>(); // doc label → folder path

    for (let i = 0; i < docList.length; i++) {
        const doc = docList[i];
        if (!doc.storage_path) continue;
        const docLabel = `doc-${i}`;
        docIndex[docLabel] = {
            document_id: doc.id,
            filename: doc.filename,
            version_id: doc.current_version_id ?? null,
            version_number: doc.active_version_number ?? null,
        };
        docStore.set(docLabel, {
            storage_path: doc.storage_path,
            file_type: doc.file_type,
            filename: doc.filename,
        });
        const path = resolvePath(doc.folder_id ?? null);
        if (path) folderPaths.set(docLabel, path);
    }

    console.log(
        "[buildProjectDocContext] available docs:",
        Object.entries(docIndex).map(([label, info]) => ({
            label,
            filename: info.filename,
            document_id: info.document_id,
            folder: folderPaths.get(label) ?? null,
        })),
    );
    return { docIndex, docStore, folderPaths };
}

export async function buildWorkflowStore(
    userId: string,
    userEmail: string | null | undefined,
    db: ReturnType<typeof createServerDb>,
): Promise<WorkflowStore> {
    const { BUILTIN_WORKFLOWS } = await import("./builtinWorkflows");
    const store: WorkflowStore = new Map();
    const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();

    // Seed built-ins first
    for (const wf of BUILTIN_WORKFLOWS) {
        store.set(wf.id, { title: wf.title, prompt_md: wf.prompt_md });
    }

    const workflowSelect =
        "id, title, prompt_md, case_skill_slug, case_skill_name, case_skill_summary, case_skill_tags, case_skill_source, case_skill_version, case_skill_content_snapshot, case_skill_synced_at";

    // Then overlay user-owned assistant workflows.
    const { data: workflows } = await db
        .from("workflows")
        .select(workflowSelect)
        .eq("user_id", userId)
        .eq("type", "assistant");
    for (const wf of workflows ?? []) {
        const prompt = composeWorkflowPrompt(wf);
        if (prompt) {
            store.set(wf.id, {
                title: wf.title,
                prompt_md: prompt,
                case_skill_slug: wf.case_skill_slug,
                case_skill_name: wf.case_skill_name,
                case_skill_summary: wf.case_skill_summary,
                case_skill_tags: wf.case_skill_tags,
                case_skill_source: wf.case_skill_source,
                case_skill_version: wf.case_skill_version,
                case_skill_synced_at: wf.case_skill_synced_at,
            });
        }
    }

    // Shared assistant workflows must also be readable by workflow tools.
    if (normalizedUserEmail) {
        const { data: shares } = await db
            .from("workflow_shares")
            .select("workflow_id")
            .eq("shared_with_email", normalizedUserEmail);
        const sharedIds = [
            ...new Set(
                ((shares ?? []) as { workflow_id: string }[]).map(
                    (share) => share.workflow_id,
                ),
            ),
        ];
        if (sharedIds.length > 0) {
            const { data: sharedWorkflows } = await db
                .from("workflows")
                .select(workflowSelect)
                .in("id", sharedIds)
                .eq("type", "assistant");
            for (const wf of sharedWorkflows ?? []) {
                const prompt = composeWorkflowPrompt(wf);
                if (prompt) {
                    store.set(wf.id, {
                        title: wf.title,
                        prompt_md: prompt,
                        case_skill_slug: wf.case_skill_slug,
                        case_skill_name: wf.case_skill_name,
                        case_skill_summary: wf.case_skill_summary,
                        case_skill_tags: wf.case_skill_tags,
                        case_skill_source: wf.case_skill_source,
                        case_skill_version: wf.case_skill_version,
                        case_skill_synced_at: wf.case_skill_synced_at,
                    });
                }
            }
        }
    }
    return store;
}
