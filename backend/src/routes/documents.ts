import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerDb } from "../lib/db";
import {
  confirmDirectUpload,
  createDirectUpload,
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  storageKey,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  loadActiveVersion,
} from "../lib/documentVersions";
import { checkProjectAccess, ensureDocAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import { registerCaseStoredObject, syncDocumentVersionToCase } from "../lib/caseSync";
import { isDemoBudgetError } from "../lib/demoUsage";

export const documentsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);
const WORD_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function errorDetail(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function sendDemoBudgetError(
  res: import("express").Response,
  err: unknown,
): boolean {
  if (!isDemoBudgetError(err)) return false;
  res.status(402).json({
    detail: errorDetail(err),
    code: "demo_budget_exceeded",
  });
  return true;
}

function arrayBufferCopy(bytes: Buffer): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

function suffixFromFilename(filename: string) {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

function contentTypeForSuffix(suffix: string) {
  return suffix === "pdf" ? "application/pdf" : WORD_CONTENT_TYPE;
}

function jsonString(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function jsonNumber(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
}

async function assertProjectWriteAccess(
  projectId: string | null,
  userId: string,
  userEmail: string | undefined,
  db: ReturnType<typeof createServerDb>,
) {
  if (!projectId) return true;
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  return access.ok;
}

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  const docs = (data ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs);
});

// POST /single-documents
documentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerDb();
    await handleDocumentUpload(req, res, userId, null, db);
  },
);

// POST /single-documents/direct-upload
// Creates metadata and a Case Vault presigned URL so large files go directly
// from the browser to storage instead of through the Vercel Function body.
documentsRouter.post("/direct-upload", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerDb();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectIdRaw = jsonString(body.project_id, 100);
  const projectId = projectIdRaw || null;

  if (!(await assertProjectWriteAccess(projectId, userId, userEmail, db))) {
    return void res.status(404).json({ detail: "Project not found" });
  }

  try {
    const session = await createDirectDocumentUploadSession({
      db,
      userId,
      projectId,
      filename: jsonString(body.filename),
      sizeBytes: jsonNumber(body.size_bytes),
      displayName: null,
      source: "upload",
    });
    res.status(201).json(session);
  } catch (err) {
    console.error("[direct-upload] create failed", err);
    return void res
      .status(isDemoBudgetError(err) ? 402 : 400)
      .json({
        detail: errorDetail(err),
        ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
      });
  }
});

// POST /single-documents/:documentId/direct-upload/complete
// Confirms a browser-direct upload and marks the document ready.
documentsRouter.post(
  "/:documentId/direct-upload/complete",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerDb();
    try {
      const updated = await completeDirectDocumentUpload({
        db,
        documentId,
        userId,
        userEmail,
        sizeBytes: jsonNumber((req.body ?? {}).size_bytes),
        etag: jsonString((req.body ?? {}).etag, 200) || null,
      });
      res.json(updated);
    } catch (err) {
      console.error("[direct-upload] complete failed", err);
      return void res
        .status(isDemoBudgetError(err) ? 402 : 400)
        .json({
          detail: errorDetail(err),
          ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
        });
    }
  },
);

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;
  const db = createServerDb();

  const { data: doc, error } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });

  // Storage now lives on document_versions — fan out and delete each
  // version's bytes (DOCX + PDF rendition) before dropping rows.
  const { data: versions } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .eq("document_id", documentId);
  await Promise.all(
    ((versions ?? []) as { storage_path?: string | null; pdf_storage_path?: string | null }[]).flatMap((v) =>
      [v.storage_path, v.pdf_storage_path]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => deleteFile(p, { db }).catch(() => {})),
    ),
  );
  await db.from("documents").delete().eq("id", documentId);
  res.status(204).send();
});

// GET /single-documents/:documentId/display
// Optional ?version_id= renders a historical version. Defaults to the
// document's current_version_id.
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerDb();

  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const fileType = (doc.file_type as string) ?? "";
  const isDocx = fileType === "docx" || fileType === "doc";

  // For DOCX, prefer the per-version PDF rendition if one exists.
  const servePath =
    isDocx && active.pdf_storage_path
      ? active.pdf_storage_path
      : active.storage_path;
  let raw: ArrayBuffer | null;
  try {
    raw = await downloadFile(servePath, { db });
  } catch (err) {
    if (sendDemoBudgetError(res, err)) return;
    return void res.status(500).json({ detail: errorDetail(err) });
  }
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document not found in storage" });
  const body = Buffer.from(raw);
  const contentType =
    servePath === active.pdf_storage_path || fileType === "pdf"
      ? "application/pdf"
      : fileType === "doc"
        ? "application/msword"
        : WORD_CONTENT_TYPE;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(body.byteLength));
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition("inline", doc.filename as string),
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.send(body);
});

// POST /single-documents/download-zip
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  const db = createServerDb();
  const { data: rawDocs, error } = await db
    .from("documents")
    .select("id, filename, file_type, current_version_id, user_id, project_id")
    .in("id", document_ids);

  if (error) return void res.status(500).json({ detail: error.message });
  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    ((rawDocs ?? []) as {
      id: string;
      filename: string;
      user_id: string;
      project_id: string | null;
    }[]).map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        d as { user_id: string; project_id: string | null },
        userId,
        userEmail,
        db,
      ),
    })),
  );
  const docs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => x.doc as { id: string; filename: string });
  if (!docs || docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const files = (
    await Promise.all(
      docs.map(async (doc) => {
      const active = await loadActiveVersion(doc.id, db);
        if (!active) return null;
        const downloadFilename = resolveDownloadFilename(
          doc.filename,
          active.display_name,
          active.version_number,
        );
        const url = await getSignedUrl(active.storage_path, 3600, downloadFilename, {
          db,
        });
        return url
          ? {
              document_id: doc.id,
              filename: downloadFilename,
              url,
              version_id: active.id,
            }
          : null;
      }),
    )
  ).filter(Boolean);

  res.json({ files });
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerDb();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = resolveDownloadFilename(
    doc.filename as string,
    active.display_name,
    active.version_number,
  );
  let url: string | null;
  try {
    url = await getSignedUrl(active.storage_path, 3600, downloadFilename, {
      db,
    });
  } catch (err) {
    if (sendDemoBudgetError(res, err)) return;
    return void res.status(500).json({ detail: errorDetail(err) });
  }
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    // Lets the frontend decide between DocView (PDF.js) and DocxView
    // (docx-preview) without a follow-up round-trip.
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
// Streams the raw .docx bytes for the given document, optionally at a
// specific tracked-changes version. Unlike /url, this bypasses R2 (avoids
// the browser CORS problem on signed URLs) so the frontend docx-preview
// viewer can load tracked-change documents directly.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerDb();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  let raw: ArrayBuffer | null;
  try {
    raw = await downloadFile(active.storage_path, { db });
  } catch (err) {
    if (sendDemoBudgetError(res, err)) return;
    return void res.status(500).json({ detail: errorDetail(err) });
  }
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });
  const filename = resolveDownloadFilename(
    doc.filename as string,
    active.display_name,
    active.version_number,
  );
  const body = Buffer.from(raw);
  res.setHeader("Content-Type", WORD_CONTENT_TYPE);
  res.setHeader("Content-Length", String(body.byteLength));
  res.setHeader("Content-Disposition", buildContentDisposition("inline", filename));
  res.setHeader("Cache-Control", "private, no-store");
  res.send(body);
});

// Compose a download-friendly filename that carries the edit version
// marker: "Purchase Agreement.docx" → "Purchase Agreement [Edited V2].docx".
// Preserves the original extension (fallback: .docx).
function versionedFilename(filename: string, version: number | null): string {
  if (!version || version < 1) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".docx";
  return `${stem} [Edited V${version}]${ext}`;
}

// Produce the filename a download should present to the user for a given
// (document, version) pair. Prefers the version's display_name (appending
// the original extension if the user didn't include one), falling back to
// the versionedFilename heuristic.
function resolveDownloadFilename(
  originalFilename: string,
  displayName: string | null | undefined,
  versionNumber: number | null,
): string {
  const dot = originalFilename.lastIndexOf(".");
  const origExt = dot > 0 ? originalFilename.slice(dot) : "";
  if (displayName && displayName.trim()) {
    const trimmed = displayName.trim();
    const trimmedDot = trimmed.lastIndexOf(".");
    const hasExt =
      trimmedDot > 0 &&
      trimmed
        .slice(trimmedDot)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/);
    if (hasExt) return trimmed;
    return origExt ? `${trimmed}${origExt}` : trimmed;
  }
  return versionedFilename(originalFilename, versionNumber);
}

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerDb();

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const { data: rows } = await db
    .from("document_versions")
    .select("id, version_number, source, created_at, display_name")
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  res.json({
    current_version_id: doc.current_version_id,
    versions: rows ?? [],
  });
});

// POST /single-documents/:documentId/versions/direct-upload
// Browser-direct upload flow for a new document version.
documentsRouter.post(
  "/:documentId/versions/direct-upload",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerDb();
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const session = await createDirectVersionUploadSession({
        db,
        documentId,
        userId,
        userEmail,
        filename: jsonString(body.filename),
        sizeBytes: jsonNumber(body.size_bytes),
        displayName: jsonString(body.display_name, 200) || null,
      });
      res.status(201).json(session);
    } catch (err) {
      console.error("[versions/direct-upload] create failed", err);
      return void res
        .status(isDemoBudgetError(err) ? 402 : 400)
        .json({
          detail: errorDetail(err),
          ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
        });
    }
  },
);

// POST /single-documents/:documentId/versions/:versionId/direct-upload/complete
documentsRouter.post(
  "/:documentId/versions/:versionId/direct-upload/complete",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerDb();
    try {
      const updated = await completeDirectVersionUpload({
        db,
        documentId,
        versionId,
        userId,
        userEmail,
        sizeBytes: jsonNumber((req.body ?? {}).size_bytes),
        etag: jsonString((req.body ?? {}).etag, 200) || null,
      });
      res.status(201).json(updated);
    } catch (err) {
      console.error("[versions/direct-upload] complete failed", err);
      return void res
        .status(isDemoBudgetError(err) ? 402 : 400)
        .json({
          detail: errorDetail(err),
          ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
        });
    }
  },
);

// POST /single-documents/:documentId/versions
// Upload a brand-new version of an existing document. The uploaded file
// becomes the new current_version_id. display_name defaults to the
// uploaded filename; client may override via the `display_name` form field.
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerDb();

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const { data: doc } = await db
      .from("documents")
      .select("id, filename, file_type, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    // Reject if the uploaded file's extension doesn't match the document's
    // declared type — otherwise every downstream viewer/extractor breaks.
    const suffix = file.originalname.includes(".")
      ? file.originalname.split(".").pop()!.toLowerCase()
      : "";
    if (doc.file_type && suffix && doc.file_type !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match document type (${doc.file_type}).`,
      });
    }

    // Peg the new version into a predictable /versions/:id path under the
    // existing document folder so ops can spot the history in storage.
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    let key = versionStorageKey(
      userId,
      documentId,
      versionSlug,
      file.originalname,
    );
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const uploadedBytes = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    ) as ArrayBuffer;
    try {
      key = await uploadFile(
        key,
        uploadedBytes,
        contentType,
        {
          db,
          userId: doc.user_id as string,
          projectId: (doc.project_id as string | null) ?? null,
          documentId,
          filename: file.originalname,
          role: "source",
          autoIndex: true,
        },
      );
    } catch (e) {
      console.error("[versions/upload] storage write failed", e);
      return void res
        .status(isDemoBudgetError(e) ? 402 : 500)
        .json({
          detail: isDemoBudgetError(e)
            ? errorDetail(e)
            : "Failed to upload new version.",
          ...(isDemoBudgetError(e) ? { code: "demo_budget_exceeded" } : {}),
        });
    }

    // Render this version's bytes to PDF up front so /display can show
    // historical versions without on-demand conversion. Same logic as the
    // initial-upload pipeline; failures don't block the version row.
    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(file.buffer);
        let pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
        const pdfBytes = pdfBuf.buffer.slice(
          pdfBuf.byteOffset,
          pdfBuf.byteOffset + pdfBuf.byteLength,
        ) as ArrayBuffer;
        pdfKey = await uploadFile(
          pdfKey,
          pdfBytes,
          "application/pdf",
          {
            db,
            userId: doc.user_id as string,
            projectId: (doc.project_id as string | null) ?? null,
            documentId,
            filename: `${versionSlug}.pdf`,
            role: "pdf_rendition",
            autoIndex: false,
          },
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[versions/upload] DOCX→PDF conversion failed for ${file.originalname}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      // For PDF uploads, the uploaded bytes are themselves the PDF rendition.
      pdfStoragePath = key;
    }

    // Per-document sequential version_number — the upload is V1 and
    // user_upload + assistant_edit count forward from there.
    const { data: maxRow } = await db
      .from("document_versions")
      .select("version_number")
      .eq("document_id", documentId)
      .in("source", ["upload", "user_upload", "assistant_edit"])
      .order("version_number", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const nextVersionNumber =
      ((maxRow?.version_number as number | null) ?? 1) + 1;

    const defaultDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : file.originalname;

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "user_upload",
        version_number: nextVersionNumber,
        display_name: defaultDisplayName,
      })
      .select("id, version_number, source, created_at, display_name")
      .single();
    if (verErr || !versionRow) {
      console.error("[versions/upload] insert failed", verErr);
      return void res
        .status(500)
        .json({ detail: "Failed to record new version." });
    }

    // Also propagate the user-provided display_name to the parent document's
    // filename so the document's display name stays in sync across the UI.
    // Preserve a sensible extension: if the display_name has none, append
    // the uploaded file's extension (fallback: the existing doc's extension).
    const documentsUpdate: Record<string, unknown> = {
      current_version_id: versionRow.id,
    };
    const providedDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : null;
    if (providedDisplayName) {
      const hasExt = /\.[a-z0-9]{1,6}$/i.test(providedDisplayName);
      const existingExt = (doc.filename as string | null)?.match(
        /\.[a-z0-9]{1,6}$/i,
      )?.[0];
      const uploadedExt = suffix ? `.${suffix}` : "";
      const ext = hasExt ? "" : uploadedExt || existingExt || "";
      documentsUpdate.filename = `${providedDisplayName}${ext}`;
    }
    await db
      .from("documents")
      .update(documentsUpdate)
      .eq("id", documentId);

    void syncDocumentVersionToCase({
      documentId,
      versionId: versionRow.id as string,
      userId: doc.user_id as string,
      projectId: (doc.project_id as string | null) ?? null,
      filename: defaultDisplayName,
      contentType,
      bytes: uploadedBytes,
      db,
    }).catch((err) => console.error("[case-sync] version upload failed", err));

    if (pdfStoragePath && pdfStoragePath !== key) {
      void registerCaseStoredObject({
        documentId,
        versionId: versionRow.id as string,
        userId: doc.user_id as string,
        projectId: (doc.project_id as string | null) ?? null,
        storageUri: pdfStoragePath,
        filename: `${versionSlug}.pdf`,
        contentType: "application/pdf",
        role: "pdf_rendition",
        db,
      }).catch((err) => console.error("[case-sync] pdf rendition link failed", err));
    }

    res.status(201).json(versionRow);
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's display_name. Pass `{ "display_name": "…" }`; an empty
// or missing value clears the override so the UI falls back to V{n}.
documentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerDb();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const raw = req.body?.display_name;
    const displayName =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

    const { data: updated, error } = await db
      .from("document_versions")
      .update({ display_name: displayName })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .select("id, version_number, source, created_at, display_name")
      .single();
    if (error || !updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
  },
);

// GET /single-documents/:documentId/tracked-change-ids
// Returns the ordered list of { kind, w_id } for every w:ins / w:del in
// the current (or specified) version's document.xml. The frontend uses
// this to tag each rendered <ins>/<del> with data-w-id, since
// docx-preview drops the w:id attribute during parsing.
documentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerDb();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path, { db });
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
  },
);

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
  req: import("express").Request,
  res: import("express").Response,
  mode: "accept" | "reject",
) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, editId } = req.params;
  const db = createServerDb();

  console.log(`[edit-resolution] incoming ${mode}`, {
    userId,
    documentId,
    editId,
  });

  const { data: edit, error: editErr } = await db
    .from("document_edits")
    .select("id, document_id, change_id, del_w_id, ins_w_id, status")
    .eq("id", editId)
    .eq("document_id", documentId)
    .single();
  console.log(`[edit-resolution] fetched edit row`, { edit, editErr });
  if (!edit) {
    console.log(`[edit-resolution] edit not found, returning 404`);
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    console.log(`[edit-resolution] edit already resolved`, {
      editId,
      status: edit.status,
    });
    const { data: doc } = await db
      .from("documents")
      .select("current_version_id, filename, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc) {
      console.log(`[edit-resolution] doc not found for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(doc, userId, userEmail, db);
    if (!accessResolved.ok) {
      console.log(`[edit-resolution] doc access denied for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId, db);
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: doc.current_version_id ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            (doc.filename as string) ?? "document.docx",
          )
        : null,
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning already-resolved payload`, payload);
    return void res.status(200).json(payload);
  }

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id, filename")
    .eq("id", documentId)
    .single();
  console.log(`[edit-resolution] fetched doc`, { doc, docErr });
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db);
  const latestPath = active?.storage_path ?? null;
  console.log(`[edit-resolution] resolved latestPath`, {
    latestPath,
    current_version_id: doc.current_version_id,
  });
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath, { db });
  console.log(`[edit-resolution] downloaded bytes`, {
    byteLength: raw?.byteLength ?? 0,
  });
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  console.log(`[edit-resolution] resolveTrackedChange result`, {
    mode,
    change_id: edit.change_id,
    wIds,
    found,
    resolvedByteLength: resolvedBytes?.byteLength ?? 0,
  });
  if (!found) {
    console.log(
      `[edit-resolution] change_id not found in docx — updating status only`,
    );
    // Still update DB status so the UI reflects the decision — the change
    // may have been auto-consumed by a previous accept/reject pass.
    const { error: updErr } = await db
      .from("document_edits")
      .update({ status: mode === "accept" ? "accepted" : "rejected", resolved_at: new Date().toISOString() })
      .eq("id", editId);
    console.log(`[edit-resolution] status-only update`, { updErr });
    const { data: filenameRow } = await db
      .from("documents")
      .select("filename")
      .eq("id", documentId)
      .single();
    const payload = {
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(
        latestPath,
        (filenameRow?.filename as string) ?? "document.docx",
      ),
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning not-found payload`, payload);
    return void res.status(200).json(payload);
  }

  // Overwrite bytes in place at the current version's storage path —
  // accept/reject mutates the existing version rather than spawning a
  // new row. This keeps document_versions lean (one row per assistant
  // edit, not one per accept/reject click) and avoids the N-versions-
  // per-doc churn as users resolve pending changes.
  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;
  console.log(`[edit-resolution] overwriting bytes in place`, {
    latestPath,
    byteLength: ab.byteLength,
  });
  const rewrittenPath = await uploadFile(
    latestPath,
    ab,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    {
      db,
      userId: doc.user_id as string,
      projectId: (doc.project_id as string | null) ?? null,
      documentId,
      versionId: doc.current_version_id as string,
      filename: (doc.filename as string | null) ?? "document.docx",
      role: "source",
      autoIndex: true,
    },
  );
  if (rewrittenPath !== latestPath) {
    await db
      .from("document_versions")
      .update({ storage_path: rewrittenPath, updated_at: new Date().toISOString() })
      .eq("id", doc.current_version_id);
  }

  void syncDocumentVersionToCase({
    documentId,
    versionId: doc.current_version_id as string,
    userId: doc.user_id as string,
    projectId: (doc.project_id as string | null) ?? null,
    filename: (doc.filename as string | null) ?? "document.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: ab,
    db,
  }).catch((err) => console.error("[case-sync] edit resolution failed", err));

  const { error: statusErr } = await db
    .from("document_edits")
    .update({
      status: mode === "accept" ? "accepted" : "rejected",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", editId);
  console.log(`[edit-resolution] updated document_edits status`, {
    editId,
    newStatus: mode === "accept" ? "accepted" : "rejected",
    statusErr,
  });

  const { count: remainingPending } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");
  console.log(`[edit-resolution] remaining pending count`, { remainingPending });

  const { data: filenameRow } = await db
    .from("documents")
    .select("filename")
    .eq("id", documentId)
    .single();
  const payload = {
    ok: true,
    version_id: doc.current_version_id,
    download_url: buildDownloadUrl(
      rewrittenPath,
      (filenameRow?.filename as string) ?? "document.docx",
    ),
    remaining_pending: remainingPending ?? 0,
  };
  console.log(`[edit-resolution] returning success payload`, payload);
  res.json(payload);
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "reject"),
);

function directUploadResponse(params: {
  document: Record<string, unknown> | null;
  version: Record<string, unknown> | null;
  upload: Awaited<ReturnType<typeof createDirectUpload>>;
  contentType: string;
  completeUrl: string;
}) {
  return {
    document: params.document,
    version: params.version,
    direct_upload: {
      method: "PUT",
      upload_url: params.upload.uploadUrl,
      headers: { "Content-Type": params.contentType },
      complete_url: params.completeUrl,
      expires_in: params.upload.expiresIn ?? 3600,
    },
  };
}

async function createDirectDocumentUploadSession(params: {
  db: ReturnType<typeof createServerDb>;
  userId: string;
  projectId: string | null;
  filename: string;
  sizeBytes: number | null;
  displayName: string | null;
  source: "upload";
}) {
  const { db, userId, projectId } = params;
  const filename = params.filename;
  if (!filename) throw new Error("filename is required");
  const suffix = suffixFromFilename(filename);
  if (!ALLOWED_TYPES.has(suffix)) {
    throw new Error(`Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`);
  }
  const sizeBytes = params.sizeBytes;
  if (sizeBytes === null || sizeBytes <= 0) {
    throw new Error("size_bytes must be a positive number");
  }
  const contentType = contentTypeForSuffix(suffix);

  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      filename,
      file_type: suffix,
      size_bytes: sizeBytes,
      status: "uploading",
    })
    .select("*")
    .single();
  if (insertErr || !doc) {
    throw new Error("Failed to create document record");
  }

  try {
    const docId = doc.id as string;
    const key = storageKey(userId, docId, filename);
    const upload = await createDirectUpload(key, contentType, sizeBytes, {
      db,
      userId,
      projectId,
      documentId: docId,
      filename,
      role: "source",
      autoIndex: true,
    });
    const pdfStoragePath = suffix === "pdf" ? upload.storageUri : null;
    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: docId,
        storage_path: upload.storageUri,
        pdf_storage_path: pdfStoragePath,
        source: params.source,
        version_number: 1,
        display_name: params.displayName || filename,
      })
      .select("id, version_number, source, created_at, display_name")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
      );
    }

    const { data: updated } = await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId)
      .select("*")
      .single();
    if (!updated) throw new Error("Failed to update document record");

    return directUploadResponse({
      document: {
        ...updated,
        storage_path: upload.storageUri,
        pdf_storage_path: pdfStoragePath,
      },
      version: versionRow as Record<string, unknown>,
      upload,
      contentType,
      completeUrl: `/single-documents/${docId}/direct-upload/complete`,
    });
  } catch (err) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    throw err;
  }
}

async function completeDirectDocumentUpload(params: {
  db: ReturnType<typeof createServerDb>;
  documentId: string;
  userId: string;
  userEmail: string | undefined;
  sizeBytes: number | null;
  etag: string | null;
}) {
  const { db, documentId, userId, userEmail } = params;
  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id, current_version_id, size_bytes")
    .eq("id", documentId)
    .single();
  if (!doc) throw new Error("Document not found");
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok) throw new Error("Document not found");
  const active = await loadActiveVersion(documentId, db);
  if (!active) throw new Error("No pending upload version found");

  const sizeBytes =
    params.sizeBytes ?? ((doc.size_bytes as number | null | undefined) ?? 0);
  await confirmDirectUpload(active.storage_path, {
    db,
    sizeBytes,
    etag: params.etag,
    autoIndex: true,
  });

  await registerCaseStoredObject({
    documentId,
    versionId: active.id,
    userId: doc.user_id as string,
    projectId: (doc.project_id as string | null) ?? null,
    storageUri: active.storage_path,
    filename: doc.filename as string,
    contentType: contentTypeForSuffix((doc.file_type as string) ?? ""),
    role: "source",
    db,
  }).catch((err) => console.error("[case-sync] direct upload link failed", err));

  const { data: updated, error: updateErr } = await db
    .from("documents")
    .update({
      size_bytes: sizeBytes,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId)
    .select("*")
    .single();
  if (updateErr || !updated) throw new Error("Failed to update document record");
  return {
    ...updated,
    storage_path: active.storage_path,
    pdf_storage_path: active.pdf_storage_path,
  };
}

async function createDirectVersionUploadSession(params: {
  db: ReturnType<typeof createServerDb>;
  documentId: string;
  userId: string;
  userEmail: string | undefined;
  filename: string;
  sizeBytes: number | null;
  displayName: string | null;
}) {
  const { db, documentId, userId, userEmail } = params;
  const filename = params.filename;
  if (!filename) throw new Error("filename is required");
  const suffix = suffixFromFilename(filename);
  if (!ALLOWED_TYPES.has(suffix)) {
    throw new Error(`Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`);
  }
  const sizeBytes = params.sizeBytes;
  if (sizeBytes === null || sizeBytes <= 0) {
    throw new Error("size_bytes must be a positive number");
  }

  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc) throw new Error("Document not found");
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok) throw new Error("Document not found");
  if (doc.file_type && suffix && doc.file_type !== suffix) {
    throw new Error(
      `Uploaded file type (${suffix}) does not match document type (${doc.file_type}).`,
    );
  }

  const { data: maxRow } = await db
    .from("document_versions")
    .select("version_number")
    .eq("document_id", documentId)
    .in("source", ["upload", "user_upload", "assistant_edit"])
    .order("version_number", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nextVersionNumber =
    ((maxRow?.version_number as number | null) ?? 1) + 1;
  const versionSlug = crypto.randomUUID().replace(/-/g, "");
  const contentType = contentTypeForSuffix(suffix);
  const key = versionStorageKey(
    userId,
    documentId,
    versionSlug,
    filename,
  );
  const upload = await createDirectUpload(key, contentType, sizeBytes, {
    db,
    userId: doc.user_id as string,
    projectId: (doc.project_id as string | null) ?? null,
    documentId,
    filename,
    role: "source",
    autoIndex: true,
  });
  const pdfStoragePath = suffix === "pdf" ? upload.storageUri : null;
  const { data: versionRow, error: verErr } = await db
    .from("document_versions")
    .insert({
      document_id: documentId,
      storage_path: upload.storageUri,
      pdf_storage_path: pdfStoragePath,
      source: "user_upload",
      version_number: nextVersionNumber,
      display_name: params.displayName || filename,
    })
    .select("id, version_number, source, created_at, display_name")
    .single();
  if (verErr || !versionRow) {
    throw new Error(
      `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
    );
  }
  return directUploadResponse({
    document: null,
    version: versionRow as Record<string, unknown>,
    upload,
    contentType,
    completeUrl: `/single-documents/${documentId}/versions/${versionRow.id}/direct-upload/complete`,
  });
}

async function completeDirectVersionUpload(params: {
  db: ReturnType<typeof createServerDb>;
  documentId: string;
  versionId: string;
  userId: string;
  userEmail: string | undefined;
  sizeBytes: number | null;
  etag: string | null;
}) {
  const { db, documentId, versionId, userId, userEmail } = params;
  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc) throw new Error("Document not found");
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok) throw new Error("Document not found");
  const { data: version } = await db
    .from("document_versions")
    .select("id, storage_path, pdf_storage_path, version_number, source, created_at, display_name")
    .eq("id", versionId)
    .eq("document_id", documentId)
    .single();
  if (!version) throw new Error("Version not found");

  await confirmDirectUpload(version.storage_path as string, {
    db,
    sizeBytes: params.sizeBytes ?? 0,
    etag: params.etag,
    autoIndex: true,
  });

  const documentsUpdate: Record<string, unknown> = {
    current_version_id: versionId,
    status: "ready",
    updated_at: new Date().toISOString(),
  };
  const displayName =
    typeof version.display_name === "string" && version.display_name.trim()
      ? version.display_name.trim().slice(0, 200)
      : null;
  if (displayName) {
    const hasExt = /\.[a-z0-9]{1,6}$/i.test(displayName);
    const existingExt = (doc.filename as string | null)?.match(
      /\.[a-z0-9]{1,6}$/i,
    )?.[0];
    const suffix = suffixFromFilename((doc.filename as string) ?? "");
    const uploadedExt = suffix ? `.${suffix}` : "";
    const ext = hasExt ? "" : uploadedExt || existingExt || "";
    documentsUpdate.filename = `${displayName}${ext}`;
  }
  await db.from("documents").update(documentsUpdate).eq("id", documentId);

  await registerCaseStoredObject({
    documentId,
    versionId,
    userId: doc.user_id as string,
    projectId: (doc.project_id as string | null) ?? null,
    storageUri: version.storage_path as string,
    filename: displayName || (doc.filename as string) || "document",
    contentType: contentTypeForSuffix((doc.file_type as string) ?? ""),
    role: "source",
    db,
  }).catch((err) => console.error("[case-sync] direct version link failed", err));

  return {
    id: version.id as string,
    version_number: (version.version_number as number | null) ?? null,
    source: version.source as string,
    created_at: version.created_at as string,
    display_name: (version.display_name as string | null) ?? null,
  };
}

async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
  db: ReturnType<typeof createServerDb>,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  const filename = file.originalname;
  const suffix = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_TYPES.has(suffix))
    return void res
      .status(400)
      .json({
        detail: `Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`,
      });

  const content = file.buffer;
  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      filename,
      file_type: suffix,
      size_bytes: content.byteLength,
      status: "processing",
    })
    .select("*")
    .single();
  if (insertErr || !doc)
    return void res
      .status(500)
      .json({ detail: "Failed to create document record" });

  try {
    const docId = doc.id as string;
    let key = storageKey(userId, docId, filename);
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const sourceBytes = Buffer.from(content);
    key = await uploadFile(
      key,
      sourceBytes,
      contentType,
      {
        db,
        userId,
        projectId,
        documentId: docId,
        filename,
        role: "source",
        autoIndex: true,
      },
    );
    const tree = await extractStructureTree(
      arrayBufferCopy(sourceBytes),
      suffix,
      filename,
    );
    const pageCount =
      suffix === "pdf" ? await countPdfPages(arrayBufferCopy(sourceBytes)) : null;

    // Convert DOCX/DOC → PDF for display. PDFs are their own rendition.
    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(sourceBytes);
        let pdfKey = convertedPdfKey(userId, docId);
        pdfKey = await uploadFile(
          pdfKey,
          Buffer.from(pdfBuf),
          "application/pdf",
          {
            db,
            userId,
            projectId,
            documentId: docId,
            filename: `${docId}.pdf`,
            role: "pdf_rendition",
            autoIndex: false,
          },
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[upload] DOCX→PDF conversion failed for ${filename}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // storage_path / pdf_storage_path live on document_versions now —
    // create the V1 "upload" row and point documents.current_version_id
    // at it.
    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: docId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "upload",
        version_number: 1,
        display_name: filename,
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
      );
    }

    const { error: updateErr } = await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        size_bytes: sourceBytes.byteLength,
        page_count: pageCount,
        structure_tree: tree ? JSON.stringify(tree) : null,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId);
    if (updateErr) {
      throw new Error(`Failed to update document record: ${updateErr.message}`);
    }

    void syncDocumentVersionToCase({
      documentId: docId,
      versionId: versionRow.id as string,
      userId,
      projectId,
      filename,
      contentType,
      bytes: sourceBytes,
      db,
    }).catch((err) => console.error("[case-sync] upload failed", err));

    if (pdfStoragePath && pdfStoragePath !== key) {
      void registerCaseStoredObject({
        documentId: docId,
        versionId: versionRow.id as string,
        userId,
        projectId,
        storageUri: pdfStoragePath,
        filename: `${docId}.pdf`,
        contentType: "application/pdf",
        role: "pdf_rendition",
        db,
      }).catch((err) => console.error("[case-sync] pdf rendition link failed", err));
    }

    const { data: updated } = await db
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    // Surface storage paths to the caller for backward compatibility.
    const responseDoc = updated
      ? { ...updated, storage_path: key, pdf_storage_path: pdfStoragePath }
      : updated;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    return void res
      .status(isDemoBudgetError(e) ? 402 : 500)
      .json({
        detail: `Document processing failed: ${errorDetail(e)}`,
        ...(isDemoBudgetError(e) ? { code: "demo_budget_exceeded" } : {}),
      });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

async function extractStructureTree(
  content: ArrayBuffer,
  fileType: string,
  _filename: string,
): Promise<unknown[] | null> {
  try {
    if (fileType === "pdf") {
      const pdfjsLib = await import(
        "pdfjs-dist/legacy/build/pdf.mjs" as string
      );
      const pdf = await (
        pdfjsLib as unknown as {
          getDocument: (opts: unknown) => {
            promise: Promise<{
              numPages: number;
              getOutline: () => Promise<{ title?: string }[]>;
            }>;
          };
        }
      ).getDocument({ data: new Uint8Array(content) }).promise;
      if (pdf.numPages <= 5) return null;
      const outline = await pdf.getOutline();
      if (outline?.length)
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
      return Array.from({ length: pdf.numPages }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page ${i + 1}`,
        level: 1,
        page_number: i + 1,
        children: [],
      }));
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(content),
      });
      const lines = result.value.split("\n").filter((l) => l.trim());
      const nodes = lines
        .slice(0, 30)
        .map((line, i) => ({
          id: `h1-${i}`,
          title: line.slice(0, 100),
          level: 1,
          page_number: null,
          children: [],
        }));
      return nodes.length ? nodes : null;
    }
  } catch {
    return null;
  }
}
