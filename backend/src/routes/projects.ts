import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerDb } from "../lib/db";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  loadActiveVersion,
} from "../lib/documentVersions";
import { downloadFile, uploadFile, storageKey } from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import { checkProjectAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import { registerCaseStoredObject, syncDocumentVersionToCase } from "../lib/caseSync";
import {
  archiveCaseMatterForProject,
  caseMatterClientForProject,
  createMatterBackedProject,
  ensureCaseMatterForProject,
  normalizeMatterLogEntries,
  normalizeMatterWorkItems,
  syncCaseMatterUpdateForProject,
} from "../lib/caseMatters";
import { isDemoBudgetError } from "../lib/demoUsage";

export const projectsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

function caseErrorDetail(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function caseErrorStatus(err: unknown, fallback = 502) {
  return isDemoBudgetError(err) ? 402 : fallback;
}

function arrayBufferCopy(bytes: Buffer): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

// GET /projects
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const db = createServerDb();

  const { data: ownProjects, error: ownError } = await db
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (ownError) return void res.status(500).json({ detail: ownError.message });

  const { data: sharedProjects, error: sharedError } = userEmail
    ? await db
        .from("projects")
        .select("*")
        .contains("shared_with", [userEmail])
        .neq("user_id", userId)
        .order("created_at", { ascending: false })
    : { data: [], error: null };
  if (sharedError)
    return void res.status(500).json({ detail: sharedError.message });

  const projects = [...(ownProjects ?? []), ...(sharedProjects ?? [])].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const result = await Promise.all(
    projects.map(async (p) => {
      const projectWithMatter =
        p.case_matter_id || p.is_owner === false
          ? p
          : await ensureCaseMatterForProject({ db, project: p as any }).catch(
              (err) => {
                console.error("[case-matters] lazy matter migration failed", err);
                return p;
              },
            );
      const [docs, chats, reviews] = await Promise.all([
        db
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("project_id", p.id),
        db
          .from("chats")
          .select("id", { count: "exact", head: true })
          .eq("project_id", p.id),
        db
          .from("tabular_reviews")
          .select("id", { count: "exact", head: true })
          .eq("project_id", p.id),
      ]);
      return {
        ...projectWithMatter,
        is_owner: p.user_id === userId,
        document_count: docs.count ?? 0,
        chat_count: chats.count ?? 0,
        review_count: reviews.count ?? 0,
      };
    }),
  );
  res.json(result);
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { name, cm_number, shared_with, practice_area, matter_type, client_name, responsible_attorney } = req.body as {
    name: string;
    cm_number?: string;
    shared_with?: string[];
    practice_area?: string;
    matter_type?: string;
    client_name?: string;
    responsible_attorney?: string;
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  const db = createServerDb();
  try {
    const data = await createMatterBackedProject({
      db,
      userId,
      input: {
        name,
        cm_number: cm_number ?? null,
        shared_with: shared_with ?? [],
        practice_area: practice_area ?? null,
        matter_type: matter_type ?? null,
        client_name: client_name ?? null,
        responsible_attorney: responsible_attorney ?? null,
      },
    });
    res.status(201).json({ ...data, documents: [] });
  } catch (err) {
    res.status(caseErrorStatus(err)).json({
      detail: `Failed to create Case.dev matter: ${caseErrorDetail(err)}`,
      ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
    });
  }
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;
  const db = createServerDb();

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project)
    return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.user_id === userId ||
    (userEmail &&
      Array.isArray(project.shared_with) &&
      project.shared_with.includes(userEmail));
  if (!canAccess)
    return void res.status(404).json({ detail: "Project not found" });

  const projectWithMatter = project.case_matter_id
    ? project
    : await ensureCaseMatterForProject({ db, project: project as any }).catch(
        (err) => {
          console.error("[case-matters] lazy matter migration failed", err);
          return project;
        },
      );

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  res.json({
    ...projectWithMatter,
    is_owner: project.user_id === userId,
    documents: docsTyped,
    folders: folderData ?? [],
  });
});

// GET /projects/:projectId/people
// Resolve the owner + every shared member to {email, display_name}. Used
// by the People modal so the UI can show display names where available
// and tag the current user as "You".
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerDb();

  const { data: project } = await db
    .from("projects")
    .select("id, user_id, shared_with")
    .eq("id", projectId)
    .single();
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const isOwner = project.user_id === userId;
  const sharedWith = (Array.isArray(project.shared_with)
    ? (project.shared_with as string[])
    : []
  ).map((e) => e.toLowerCase());
  const isShared =
    !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared)
    return void res.status(404).json({ detail: "Project not found" });

  // Pull every auth user (matching the lookup endpoint's pattern). For
  // larger deployments this should page or be replaced with a bulk-by-id
  // RPC, but it keeps things simple while user counts are modest.
  const { data: usersData } = await db.auth.admin.listUsers({ perPage: 1000 });
  const allUsers = usersData?.users ?? [];
  const userByEmail = new Map<string, { id: string; email: string }>();
  const userById = new Map<string, { id: string; email: string }>();
  for (const u of allUsers) {
    if (!u.email) continue;
    const lower = u.email.toLowerCase();
    userByEmail.set(lower, { id: u.id, email: u.email });
    userById.set(u.id, { id: u.id, email: u.email });
  }

  const memberUserIds: string[] = [];
  for (const email of sharedWith) {
    const u = userByEmail.get(email);
    if (u) memberUserIds.push(u.id);
  }

  const profileIds = [
    project.user_id as string,
    ...memberUserIds,
  ].filter((x, i, arr) => arr.indexOf(x) === i);

  const profileByUserId = new Map<
    string,
    { display_name: string | null; organisation: string | null }
  >();
  if (profileIds.length > 0) {
    const { data: profiles } = await db
      .from("user_profiles")
      .select("user_id, display_name, organisation")
      .in("user_id", profileIds);
    for (const p of profiles ?? []) {
      profileByUserId.set(p.user_id as string, {
        display_name: (p.display_name as string | null) ?? null,
        organisation: (p.organisation as string | null) ?? null,
      });
    }
  }

  const ownerInfo = userById.get(project.user_id as string);
  const owner = {
    user_id: project.user_id,
    email: ownerInfo?.email ?? null,
    display_name:
      profileByUserId.get(project.user_id as string)?.display_name ?? null,
  };
  const members = sharedWith.map((email) => {
    const u = userByEmail.get(email);
    const display_name = u
      ? profileByUserId.get(u.id)?.display_name ?? null
      : null;
    return { email, display_name };
  });

  res.json({ owner, members });
});

// GET /projects/:projectId/matter-log — Case matter log plus lightweight Mike events.
projectsRouter.get("/:projectId/matter-log", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerDb();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Matter not found" });

  try {
    const { client, matterId } = await caseMatterClientForProject({ db, projectId });
    const caseLogs = normalizeMatterLogEntries(
      await client.listMatterLogEntries(matterId),
    ).map((entry) => ({ source: "case", ...entry }));
    const [{ data: docs }, { data: chats }] = await Promise.all([
      db
        .from("documents")
        .select("id, filename, status, created_at, updated_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(25),
      db
        .from("chats")
        .select("id, title, created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);
    const mikeEvents = [
      ...((docs ?? []) as any[]).map((doc) => ({
        source: "mike",
        id: `doc-${doc.id}`,
        event_type: "mike.document",
        summary: `Document ${doc.status === "ready" ? "ready" : doc.status}: ${doc.filename}`,
        created_at: doc.updated_at ?? doc.created_at,
        details: { document_id: doc.id, filename: doc.filename, status: doc.status },
      })),
      ...((chats ?? []) as any[]).map((chat) => ({
        source: "mike",
        id: `chat-${chat.id}`,
        event_type: "mike.chat",
        summary: `Chat created: ${chat.title ?? "Untitled Chat"}`,
        created_at: chat.created_at,
        details: { chat_id: chat.id, title: chat.title },
      })),
    ];
    res.json(
      [...caseLogs, ...mikeEvents].sort(
        (a, b) =>
          new Date((b as any).created_at ?? (b as any).occurred_at ?? 0).getTime() -
          new Date((a as any).created_at ?? (a as any).occurred_at ?? 0).getTime(),
      ),
    );
  } catch (err) {
    res.status(caseErrorStatus(err)).json({
      detail: caseErrorDetail(err),
      ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
    });
  }
});

projectsRouter.get("/:projectId/work-items", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerDb();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Matter not found" });
  try {
    const { client, matterId } = await caseMatterClientForProject({ db, projectId });
    res.json(normalizeMatterWorkItems(await client.listMatterWorkItems(matterId)));
  } catch (err) {
    res.status(caseErrorStatus(err)).json({
      detail: caseErrorDetail(err),
      ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
    });
  }
});

projectsRouter.post("/:projectId/work-items", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerDb();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Matter not found" });
  const body = req.body as {
    title?: string;
    description?: string | null;
    type?: string;
    priority?: string;
    instructions?: string | null;
    due_at?: string | null;
  };
  if (!body.title?.trim()) {
    return void res.status(400).json({ detail: "title is required" });
  }
  try {
    const { client, matterId } = await caseMatterClientForProject({ db, projectId });
    const item = await client.createMatterWorkItem(matterId, {
      title: body.title.trim(),
      description: body.description ?? null,
      type: body.type ?? "task",
      priority: body.priority ?? "normal",
      instructions: body.instructions ?? null,
      due_at: body.due_at ?? null,
      metadata: { source: "mike", mike_project_id: projectId },
    });
    res.status(201).json(item);
  } catch (err) {
    res.status(caseErrorStatus(err)).json({
      detail: caseErrorDetail(err),
      ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
    });
  }
});

projectsRouter.patch("/:projectId/work-items/:workItemId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, workItemId } = req.params;
  const db = createServerDb();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Matter not found" });
  try {
    const { client, matterId } = await caseMatterClientForProject({ db, projectId });
    res.json(await client.updateMatterWorkItem(matterId, workItemId, req.body ?? {}));
  } catch (err) {
    res.status(caseErrorStatus(err)).json({
      detail: caseErrorDetail(err),
      ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
    });
  }
});

projectsRouter.post("/:projectId/work-items/:workItemId/decision", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, workItemId } = req.params;
  const db = createServerDb();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Matter not found" });
  const decision = req.body?.decision;
  if (!["approve", "revise", "block", "reassign"].includes(decision)) {
    return void res.status(400).json({ detail: "decision must be approve, revise, block, or reassign" });
  }
  try {
    const { client, matterId } = await caseMatterClientForProject({ db, projectId });
    res.json(
      await client.decideMatterWorkItem(matterId, workItemId, {
        decision,
        reason: req.body?.reason ?? null,
        agent_type_id: req.body?.agent_type_id ?? null,
        metadata: { source: "mike", mike_project_id: projectId },
      }),
    );
  } catch (err) {
    res.status(caseErrorStatus(err)).json({
      detail: caseErrorDetail(err),
      ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
    });
  }
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const db = createServerDb();
  const { data: existing } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing)
    return void res.status(404).json({ detail: "Matter not found" });

  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.cm_number != null) updates.cm_number = req.body.cm_number;
  if (req.body.practice_area != null) updates.practice_area = req.body.practice_area;
  if (req.body.matter_type != null) updates.matter_type = req.body.matter_type;
  if (req.body.client_name != null) updates.client_name = req.body.client_name;
  if (req.body.responsible_attorney != null) updates.responsible_attorney = req.body.responsible_attorney;
  if (req.body.matter_status != null) updates.matter_status = req.body.matter_status;
  if (Array.isArray(req.body.shared_with)) {
    // Normalise: lowercase + dedupe + drop empties.
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of req.body.shared_with) {
      if (typeof raw !== "string") continue;
      const e = raw.trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      cleaned.push(e);
    }
    updates.shared_with = cleaned;
  }

  const matterUpdates: Record<string, unknown> = {};
  for (const key of [
    "name",
    "cm_number",
    "practice_area",
    "matter_type",
    "client_name",
    "responsible_attorney",
  ]) {
    if (key in updates) matterUpdates[key] = updates[key];
  }
  if ("matter_status" in updates) matterUpdates.status = updates.matter_status;
  if (Object.keys(matterUpdates).length > 0) {
    try {
      await syncCaseMatterUpdateForProject({
        db,
        project: existing as any,
        updates: matterUpdates as any,
      });
    } catch (err) {
      return void res.status(caseErrorStatus(err)).json({
        detail: `Failed to update Case.dev matter: ${caseErrorDetail(err)}`,
        ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
      });
    }
  }

  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data)
    return void res.status(404).json({ detail: "Matter not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json({ ...data, documents: docsTyped, folders: folderData ?? [] });
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const db = createServerDb();
  const { data: project } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!project) return void res.status(404).json({ detail: "Matter not found" });
  try {
    await archiveCaseMatterForProject({ db, project: project as any });
  } catch (err) {
    return void res.status(caseErrorStatus(err)).json({
      detail: `Failed to archive Case.dev matter: ${caseErrorDetail(err)}`,
      ...(isDemoBudgetError(err) ? { code: "demo_budget_exceeded" } : {}),
    });
  }
  const { error } = await db
    .from("projects")
    .delete()
    .eq("id", projectId)
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerDb();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: docs } = await db
    .from("documents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json(docsTyped);
});

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const db = createServerDb();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Adding-by-id pulls a doc into the project — only the doc's owner
    // is allowed to do that, so other people's standalone docs can't be
    // siphoned into a project the requester happens to share.
    const { data: doc } = await db
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .eq("user_id", userId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    // Already in this project — idempotent
    if (doc.project_id === projectId) return void res.json(doc);

    const active = await loadActiveVersion(documentId, db);
    if (doc.status !== "ready" || !active?.storage_path) {
      return void res.status(409).json({
        detail:
          "Document is not ready yet and cannot be added to a matter. Re-upload it or wait for processing to finish.",
      });
    }
    const filename = doc.filename as string;
    const contentType =
      doc.file_type === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    if (doc.project_id === null) {
      // Standalone → project: move the current version into the project
      // owner's Case vault so project storage follows Mike's sharing model.
      if (active?.storage_path) {
        const sourceBytes = await downloadFile(active.storage_path, { db });
        if (!sourceBytes) {
          return void res
            .status(500)
            .json({ detail: "Failed to read source document bytes" });
        }
        let projectSourcePath = storageKey(userId, documentId, filename);
        projectSourcePath = await uploadFile(projectSourcePath, sourceBytes, contentType, {
          db,
          userId: doc.user_id as string,
          projectId,
          documentId,
          versionId: active.id,
          filename,
          role: "source",
          autoIndex: true,
        });

        let projectPdfPath: string | null = null;
        if (active.pdf_storage_path) {
          if (active.pdf_storage_path === active.storage_path || doc.file_type === "pdf") {
            projectPdfPath = projectSourcePath;
          } else {
            const pdfBytes = await downloadFile(active.pdf_storage_path, { db });
            if (pdfBytes) {
              let pdfPath = convertedPdfKey(userId, documentId);
              pdfPath = await uploadFile(pdfPath, pdfBytes, "application/pdf", {
                db,
                userId: doc.user_id as string,
                projectId,
                documentId,
                versionId: active.id,
                filename: `${filename.replace(/\.[^/.]+$/, "") || "document"}.pdf`,
                role: "pdf_rendition",
                autoIndex: false,
              });
              projectPdfPath = pdfPath;
              void registerCaseStoredObject({
                documentId,
                versionId: active.id,
                userId: doc.user_id as string,
                projectId,
                storageUri: pdfPath,
                filename: `${filename.replace(/\.[^/.]+$/, "") || "document"}.pdf`,
                contentType: "application/pdf",
                bytes: pdfBytes,
                role: "pdf_rendition",
                db,
              }).catch((err) => console.error("[case-sync] assigned PDF link failed", err));
            }
          }
        } else if (doc.file_type === "pdf") {
          projectPdfPath = projectSourcePath;
        }

        await db
          .from("document_versions")
          .update({
            storage_path: projectSourcePath,
            pdf_storage_path: projectPdfPath,
            updated_at: new Date().toISOString(),
          })
          .eq("id", active.id);
        void syncDocumentVersionToCase({
          documentId,
          versionId: active.id,
          userId: doc.user_id as string,
          projectId,
          filename,
          contentType,
          bytes: sourceBytes,
          db,
        }).catch((err) => console.error("[case-sync] assigned document failed", err));
      }

      // Assign project_id after the storage move succeeds.
      const { data: updated, error } = await db
        .from("documents")
        .update({ project_id: projectId, updated_at: new Date().toISOString() })
        .eq("id", documentId)
        .select("*")
        .single();
      if (error || !updated)
        return void res.status(500).json({ detail: "Failed to update document" });
      return void res.json(updated);
    } else {
      // Belongs to another project → duplicate record AND copy the
      // underlying storage objects so each project's copy is fully
      // independent (edits/version bumps on one don't leak into the
      // other).
      const srcBytes = await downloadFile(active.storage_path, { db });
      if (!srcBytes) {
        return void res
          .status(500)
          .json({ detail: "Failed to read source document bytes" });
      }
      const { data: copy, error } = await db
        .from("documents")
        .insert({
          project_id: projectId,
          user_id: userId,
          filename: doc.filename,
          file_type: doc.file_type,
          size_bytes: doc.size_bytes,
          page_count: doc.page_count,
          structure_tree: doc.structure_tree,
          status: doc.status,
        })
        .select("*")
        .single();
      if (error || !copy)
        return void res.status(500).json({ detail: "Failed to copy document" });

      let copyVersionRowId: string | null = null;
          let newKey = storageKey(userId, copy.id as string, doc.filename);
          newKey = await uploadFile(newKey, srcBytes, contentType, {
            db,
            userId,
            projectId,
            documentId: copy.id as string,
            filename: doc.filename,
            role: "source",
            autoIndex: true,
          });

          // PDFs share one object for source + display rendition. DOCX
          // store the converted PDF at a separate `converted-pdfs/` key —
          // copy that too if it exists so the copy renders without going
          // back through libreoffice.
          let newPdfPath: string | null = null;
          if (active.pdf_storage_path) {
            if (active.pdf_storage_path === active.storage_path || doc.file_type === "pdf") {
              newPdfPath = newKey;
            } else {
              const pdfBytes = await downloadFile(active.pdf_storage_path, { db });
              if (pdfBytes) {
                let newPdfKey = convertedPdfKey(userId, copy.id as string);
                newPdfKey = await uploadFile(newPdfKey, pdfBytes, "application/pdf", {
                  db,
                  userId,
                  projectId,
                  documentId: copy.id as string,
                  filename: `${doc.filename.replace(/\.[^/.]+$/, "") || "document"}.pdf`,
                  role: "pdf_rendition",
                  autoIndex: false,
                });
                newPdfPath = newPdfKey;
              }
            }
          }

          const { data: newV } = await db
            .from("document_versions")
            .insert({
              document_id: copy.id,
              storage_path: newKey,
              pdf_storage_path: newPdfPath,
              source: active.source ?? "upload",
              version_number: active.version_number ?? 1,
              display_name: active.display_name ?? doc.filename,
            })
            .select("id")
            .single();
          copyVersionRowId = (newV?.id as string | null) ?? null;
          if (copyVersionRowId) {
            await db
              .from("documents")
              .update({ current_version_id: copyVersionRowId })
              .eq("id", copy.id);
            void syncDocumentVersionToCase({
              documentId: copy.id as string,
              versionId: copyVersionRowId,
              userId,
              projectId,
              filename: doc.filename,
              contentType,
              bytes: srcBytes,
              db,
            }).catch((err) => console.error("[case-sync] copied document failed", err));
            if (newPdfPath && newPdfPath !== newKey) {
              void registerCaseStoredObject({
                documentId: copy.id as string,
                versionId: copyVersionRowId,
                userId,
                projectId,
                storageUri: newPdfPath,
                filename: `${doc.filename.replace(/\.[^/.]+$/, "") || "document"}.pdf`,
                contentType: "application/pdf",
                role: "pdf_rendition",
                db,
              }).catch((err) => console.error("[case-sync] copied PDF link failed", err));
            }
          }
      return void res.status(201).json(copy);
    }
  },
);

// POST /projects/:projectId/documents
projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerDb();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    await handleDocumentUpload(req, res, userId, projectId, db);
  },
);

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list — and so collaborators
// see each other's chats inside the project even though those don't appear
// in the global list.
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerDb();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data ?? []);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as { name: string; parent_folder_id?: string | null };
  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });

  const db = createServerDb();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const { data: parent } = await db.from("project_subfolders").select("id").eq("id", parent_folder_id).eq("project_id", projectId).single();
    if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const { data, error } = await db.from("project_subfolders").insert({
    project_id: projectId,
    user_id: userId,
    name: name.trim(),
    parent_folder_id: parent_folder_id ?? null,
  }).select("*").single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const body = req.body as { name?: string; parent_folder_id?: string | null };

  const db = createServerDb();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) return void res.status(400).json({ detail: "Cannot move a folder into itself or a descendant" });
        const { data: p }: { data: { parent_folder_id: string | null } | null } =
          await db.from("project_subfolders").select("parent_folder_id").eq("id", cur).single();
        cur = p?.parent_folder_id ?? null;
      }
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  const { data, error } = await db.from("project_subfolders")
    .update(updates)
    .eq("id", folderId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Folder not found" });
  res.json(data);
});

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const db = createServerDb();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Move direct documents to root before cascade-deleting subfolders
  await db.from("documents").update({ folder_id: null }).eq("folder_id", folderId);

  const { error } = await db.from("project_subfolders")
    .delete().eq("id", folderId).eq("project_id", projectId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };

  const db = createServerDb();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db.from("documents")
    .update({ folder_id: folder_id ?? null, updated_at: new Date().toISOString() })
    .eq("id", documentId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Document not found" });
  res.json(data);
});

export async function handleDocumentUpload(
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
    key = await uploadFile(key, sourceBytes, contentType, {
      db,
      userId,
      projectId,
      documentId: docId,
      filename,
      role: "source",
      autoIndex: true,
    });

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
            filename: `${filename.replace(/\.[^/.]+$/, "") || "document"}.pdf`,
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

    // Storage paths live on document_versions — create the V1 row and
    // point documents.current_version_id at it.
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
    }).catch((err) => console.error("[case-sync] project upload failed", err));
    if (pdfStoragePath && pdfStoragePath !== key) {
      void registerCaseStoredObject({
        documentId: docId,
        versionId: versionRow.id as string,
        userId,
        projectId,
        storageUri: pdfStoragePath,
        filename: `${filename.replace(/\.[^/.]+$/, "") || "document"}.pdf`,
        contentType: "application/pdf",
        role: "pdf_rendition",
        db,
      }).catch((err) => console.error("[case-sync] project PDF link failed", err));
    }

    const { data: updated } = await db
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    const responseDoc = updated
      ? {
            ...updated,
            storage_path: key,
            pdf_storage_path: pdfStoragePath,
        }
      : updated;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    return void res
      .status(caseErrorStatus(e, 500))
      .json({
        detail: `Document processing failed: ${caseErrorDetail(e)}`,
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
  filename: string,
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
      if (outline?.length) {
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
      }
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
