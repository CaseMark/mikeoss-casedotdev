import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerDb } from "../lib/db";
import {
  composeWorkflowPrompt,
  getCaseSkillsClient,
  normalizeSkillTags,
  serializeSkill,
  skillFieldsFromDetail,
  summarizeSkill,
} from "../lib/caseSkills";
import { CaseApiError, type CaseSkillSummary } from "../lib/caseClient";

export const workflowsRouter = Router();

type Db = ReturnType<typeof createServerDb>;

type WorkflowRecord = {
  id: string;
  user_id: string | null;
  is_system: boolean;
  prompt_md?: string | null;
  case_skill_content_snapshot?: string | null;
  [key: string]: unknown;
};

type WorkflowShareRow = {
  workflow_id: string;
  shared_by_user_id: string | null;
  allow_edit: boolean;
};

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
};

type CaseSkillListResult =
  | {
      skills?: CaseSkillSummary[];
      results?: CaseSkillSummary[];
      data?: CaseSkillSummary[];
      next_cursor?: string | null;
      nextCursor?: string | null;
      has_more?: boolean;
      hasMore?: boolean;
    }
  | CaseSkillSummary[];

type CaseSkillFavoriteRow = {
  skill_slug: string;
  skill_name: string;
  skill_summary: string | null;
  skill_tags: unknown;
  skill_source: string | null;
  skill_version: string | null;
  skill_author_name: string | null;
  skill_license: string | null;
  created_at: string;
};

type WorkflowAccess =
  | {
      workflow: WorkflowRecord;
      allowEdit: boolean;
      isOwner: boolean;
    }
  | null;

function asSkillList(result: CaseSkillListResult) {
  if (Array.isArray(result)) {
    return { skills: result, next_cursor: null, has_more: false };
  }
  const skills = result.skills ?? result.results ?? result.data ?? [];
  return {
    skills,
    next_cursor: result.next_cursor ?? result.nextCursor ?? null,
    has_more: result.has_more ?? result.hasMore ?? false,
  };
}

function isMissingTableError(error: { message?: string } | null | undefined) {
  const message = error?.message ?? "";
  return (
    message.includes('relation "case_skill_favorites" does not exist') ||
    message.includes("relation \"case_skill_favorites\" does not exist")
  );
}

function favoriteRowToSkill(row: CaseSkillFavoriteRow) {
  return {
    slug: row.skill_slug,
    name: row.skill_name,
    summary: row.skill_summary ?? null,
    tags: normalizeSkillTags(row.skill_tags),
    score: null,
    source:
      row.skill_source === "custom" || row.skill_source === "curated"
        ? row.skill_source
        : null,
    version: row.skill_version ?? null,
    author_name: row.skill_author_name ?? null,
    license: row.skill_license ?? null,
    favorited_at: row.created_at,
  };
}

function skillPayload(body: unknown): CaseSkillSummary | null {
  const value =
    body && typeof body === "object" && "skill" in body
      ? (body as { skill?: unknown }).skill
      : body;
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!slug || !name) return null;
  return {
    slug,
    name,
    summary: typeof raw.summary === "string" ? raw.summary : null,
    tags: normalizeSkillTags(raw.tags),
    score: typeof raw.score === "number" ? raw.score : undefined,
    source:
      raw.source === "custom" || raw.source === "curated"
        ? raw.source
        : undefined,
    version:
      typeof raw.version === "string" || typeof raw.version === "number"
        ? raw.version
        : undefined,
    author_name: typeof raw.author_name === "string" ? raw.author_name : null,
    license: typeof raw.license === "string" ? raw.license : null,
  };
}

function withWorkflowAccess<T extends Record<string, unknown>>(
  workflow: T,
  access: { allowEdit: boolean; isOwner: boolean; sharedByName?: string | null },
) {
  return {
    ...workflow,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

async function resolveWorkflowAccess(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowAccess> {
  const { data: workflow } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (!workflow) return null;
  const workflowRecord = workflow as WorkflowRecord;
  if (workflowRecord.user_id === userId) {
    return { workflow: workflowRecord, allowEdit: true, isOwner: true };
  }

  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
  if (!normalizedUserEmail) return null;

  const { data: share } = await db
    .from("workflow_shares")
    .select("allow_edit")
    .eq("workflow_id", workflowId)
    .eq("shared_with_email", normalizedUserEmail)
    .maybeSingle();
  if (!share) return null;

  return { workflow: workflowRecord, allowEdit: !!share.allow_edit, isOwner: false };
}

// GET /workflows
workflowsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { type } = req.query as { type?: string };
  const db = createServerDb();

  // Own workflows
  let ownQuery = db
    .from("workflows")
    .select("*")
    .eq("user_id", userId)
    .eq("is_system", false)
    .order("created_at", { ascending: false });
  if (type) ownQuery = ownQuery.eq("type", type);
  const { data: own, error: ownErr } = await ownQuery;
  if (ownErr) return void res.status(500).json({ detail: ownErr.message });

  // Shared workflows (where the current user's email appears in workflow_shares)
  const normalizedUserEmail = userEmail.trim().toLowerCase();
  const { data: shares } = await db
    .from("workflow_shares")
    .select("workflow_id, shared_by_user_id, allow_edit")
    .eq("shared_with_email", normalizedUserEmail);

  let sharedWorkflows: Record<string, unknown>[] = [];
  if (shares && shares.length > 0) {
    const typedShares = shares as WorkflowShareRow[];
    const sharedIds = typedShares.map((s) => s.workflow_id);
    let sharedQuery = db.from("workflows").select("*").in("id", sharedIds);
    if (type) sharedQuery = sharedQuery.eq("type", type);
    const { data: wfs } = await sharedQuery;

    if (wfs && wfs.length > 0) {
      // Fetch sharer profiles
      const sharerIds = [
        ...new Set(typedShares.map((s) => s.shared_by_user_id).filter(Boolean)),
      ] as string[];
      const { data: profiles } = sharerIds.length > 0
        ? await db.from("user_profiles").select("user_id, display_name").in("user_id", sharerIds)
        : { data: [] };
      const typedProfiles = (profiles ?? []) as UserProfileRow[];

      // Fetch sharer emails via admin client
      const { data: authData } = await db.auth.admin.listUsers({ perPage: 1000 });
      const authUsers = authData?.users ?? [];

      sharedWorkflows = (wfs as WorkflowRecord[]).map((wf) => {
        const share = typedShares.find((s) => s.workflow_id === wf.id);
        const sharerId = share?.shared_by_user_id;
        const profile = typedProfiles.find((p) => p.user_id === sharerId);
        const authUser = authUsers.find((u) => u.id === sharerId);
        const shared_by_name = profile?.display_name || authUser?.email || null;
        return withWorkflowAccess(wf, {
          allowEdit: !!share?.allow_edit,
          isOwner: false,
          sharedByName: shared_by_name,
        });
      });
    }
  }

  const ownWithFlag = ((own ?? []) as WorkflowRecord[]).map((wf) =>
    withWorkflowAccess(wf, { allowEdit: true, isOwner: true }),
  );
  res.json([...ownWithFlag, ...sharedWorkflows]);
});

// POST /workflows
workflowsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { title, type, prompt_md, columns_config, practice } = req.body as {
    title: string;
    type: string;
    prompt_md?: string;
    columns_config?: unknown;
    practice?: string | null;
  };
  if (!title?.trim())
    return void res.status(400).json({ detail: "title is required" });
  if (!["assistant", "tabular"].includes(type))
    return void res
      .status(400)
      .json({ detail: "type must be 'assistant' or 'tabular'" });

  const db = createServerDb();
  const { data, error } = await db
    .from("workflows")
    .insert({
      user_id: userId,
      title: title.trim(),
      type,
      prompt_md: prompt_md ?? null,
      columns_config: columns_config ?? null,
      practice: practice ?? null,
      is_system: false,
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

async function handleWorkflowUpdate(req: import("express").Request, res: import("express").Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.title != null) updates.title = req.body.title;
  if ("prompt_md" in req.body) updates.prompt_md = req.body.prompt_md ?? null;
  if (req.body.columns_config != null)
    updates.columns_config = req.body.columns_config;
  if ("practice" in req.body) updates.practice = req.body.practice ?? null;

  const db = createServerDb();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access || access.workflow.is_system || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const { data, error } = await db
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .eq("is_system", false)
    .select("*")
    .single();
  if (error || !data)
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  res.json(
    withWorkflowAccess(data, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, handleWorkflowUpdate);

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, handleWorkflowUpdate);

// GET /workflows/skills/search
workflowsRouter.get("/skills/search", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(20, Math.max(1, rawLimit))
    : 10;
  if (!q) return void res.status(400).json({ detail: "q is required" });

  const db = createServerDb();
  try {
    const { client, keySource } = await getCaseSkillsClient(userId, db);
    const result = await client.searchSkills({ query: q, limit });
    res.json({
      key_source: keySource,
      methods_used: result.methods_used ?? [],
      results: (result.results ?? []).map(summarizeSkill),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(400).json({ detail });
  }
});

// GET /workflows/skills/custom
workflowsRouter.get("/skills/custom", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(100, Math.max(1, rawLimit))
    : 50;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const tag = typeof req.query.tag === "string" ? req.query.tag : null;
  const db = createServerDb();
  try {
    const { client, keySource } = await getCaseSkillsClient(userId, db);
    const result = await client.listCustomSkills({ limit, cursor, tag });
    res.json({
      key_source: keySource,
      skills: (result.skills ?? []).map(summarizeSkill),
      next_cursor: result.next_cursor ?? null,
      has_more: result.has_more ?? false,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(400).json({ detail });
  }
});

// GET /workflows/skills/browse
workflowsRouter.get("/skills/browse", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 30;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(100, Math.max(1, rawLimit))
    : 30;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const db = createServerDb();
  try {
    const { client, keySource } = await getCaseSkillsClient(userId, db);
    let result: ReturnType<typeof asSkillList>;
    try {
      result = asSkillList(await client.listSkills({ limit, cursor }));
    } catch (err) {
      if (!(err instanceof CaseApiError && err.status === 405)) throw err;
      const fallback = await client.searchSkills({
        query: "litigation workflow",
        limit,
      });
      result = {
        skills: fallback.results ?? [],
        next_cursor: null,
        has_more: false,
      };
    }
    res.json({
      key_source: keySource,
      skills: result.skills.map(summarizeSkill),
      next_cursor: result.next_cursor,
      has_more: result.has_more,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(400).json({ detail });
  }
});

// GET /workflows/skills/favorites
workflowsRouter.get("/skills/favorites", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const { data, error } = await db
    .from("case_skill_favorites")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (isMissingTableError(error)) {
    return void res.json({ favorites: [] });
  }
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({
    favorites: ((data ?? []) as CaseSkillFavoriteRow[]).map(favoriteRowToSkill),
  });
});

// POST /workflows/skills/favorites
workflowsRouter.post("/skills/favorites", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const skill = skillPayload(req.body);
  if (!skill) {
    return void res
      .status(400)
      .json({ detail: "skill with slug and name is required" });
  }

  const db = createServerDb();
  const { data, error } = await db
    .from("case_skill_favorites")
    .upsert(
      {
        user_id: userId,
        skill_slug: skill.slug,
        skill_name: skill.name,
        skill_summary: skill.summary ?? null,
        skill_tags: normalizeSkillTags(skill.tags),
        skill_source: skill.source ?? null,
        skill_version:
          skill.version === undefined || skill.version === null
            ? null
            : String(skill.version),
        skill_author_name: skill.author_name ?? null,
        skill_license: skill.license ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,skill_slug" },
    )
    .select("*")
    .single();
  if (error || !data) {
    return void res
      .status(500)
      .json({ detail: error?.message ?? "Failed to favorite skill" });
  }
  res.status(201).json(favoriteRowToSkill(data as CaseSkillFavoriteRow));
});

// DELETE /workflows/skills/favorites/:slug
workflowsRouter.delete("/skills/favorites/:slug", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { slug } = req.params;
  const db = createServerDb();
  const { error } = await db
    .from("case_skill_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("skill_slug", slug);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /workflows/skills/:slug
workflowsRouter.get("/skills/:slug", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { slug } = req.params;
  const db = createServerDb();
  try {
    const { client, keySource } = await getCaseSkillsClient(userId, db);
    const skill = await client.readSkill(slug);
    res.json({ key_source: keySource, skill: serializeSkill(skill) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(400).json({ detail });
  }
});

// POST /workflows/from-skill
workflowsRouter.post("/from-skill", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const slug = typeof req.body?.slug === "string" ? req.body.slug.trim() : "";
  const title =
    typeof req.body?.title === "string" && req.body.title.trim()
      ? req.body.title.trim()
      : null;
  const practice =
    typeof req.body?.practice === "string" && req.body.practice.trim()
      ? req.body.practice.trim()
      : null;
  const promptMd =
    typeof req.body?.prompt_md === "string" ? req.body.prompt_md : null;
  if (!slug) return void res.status(400).json({ detail: "slug is required" });

  const db = createServerDb();
  try {
    const { client } = await getCaseSkillsClient(userId, db);
    const skill = await client.readSkill(slug);
    const { data, error } = await db
      .from("workflows")
      .insert({
        user_id: userId,
        title: title ?? skill.name,
        type: "assistant",
        prompt_md: promptMd,
        columns_config: null,
        practice: practice ?? normalizeSkillTags(skill.tags)[0] ?? null,
        is_system: false,
        ...skillFieldsFromDetail(skill),
      })
      .select("*")
      .single();
    if (error || !data) {
      return void res
        .status(500)
        .json({ detail: error?.message ?? "Failed to create workflow" });
    }
    res.status(201).json({
      ...data,
      composed_prompt_md: composeWorkflowPrompt(data),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(400).json({ detail });
  }
});

// POST /workflows/:workflowId/refresh-skill
workflowsRouter.post("/:workflowId/refresh-skill", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const db = createServerDb();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access || access.workflow.is_system || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const slug =
    typeof access.workflow.case_skill_slug === "string"
      ? access.workflow.case_skill_slug
      : "";
  if (!slug) {
    return void res
      .status(400)
      .json({ detail: "Workflow is not linked to a Case.dev skill" });
  }

  try {
    const { client } = await getCaseSkillsClient(userId, db);
    const skill = await client.readSkill(slug);
    const { data, error } = await db
      .from("workflows")
      .update(skillFieldsFromDetail(skill))
      .eq("id", workflowId)
      .eq("is_system", false)
      .select("*")
      .single();
    if (error || !data) {
      return void res
        .status(500)
        .json({ detail: error?.message ?? "Failed to refresh workflow skill" });
    }
    res.json({
      ...data,
      allow_edit: access.allowEdit,
      is_owner: access.isOwner,
      composed_prompt_md: composeWorkflowPrompt(data),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(400).json({ detail });
  }
});

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerDb();
  const { error } = await db
    .from("workflows")
    .delete()
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const { data, error } = await db
    .from("hidden_workflows")
    .select("workflow_id")
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(((data ?? []) as { workflow_id: string }[]).map((r) => r.workflow_id));
});

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflow_id } = req.body as { workflow_id: string };
  if (!workflow_id?.trim())
    return void res.status(400).json({ detail: "workflow_id is required" });
  const db = createServerDb();
  const { error } = await db
    .from("hidden_workflows")
    .upsert({ user_id: userId, workflow_id }, { onConflict: "user_id,workflow_id" });
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerDb();
  const { error } = await db
    .from("hidden_workflows")
    .delete()
    .eq("user_id", userId)
    .eq("workflow_id", workflowId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const db = createServerDb();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access)
    return void res.status(404).json({ detail: "Workflow not found" });
  res.json(
    withWorkflowAccess(access.workflow, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
});

// GET /workflows/:workflowId/shares
workflowsRouter.get("/:workflowId/shares", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerDb();

  const { data: wf } = await db
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const { data: shares, error } = await db
    .from("workflow_shares")
    .select("id, shared_with_email, allow_edit, created_at")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });
  if (error) return void res.status(500).json({ detail: error.message });

  res.json(shares ?? []);
});

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete("/:workflowId/shares/:shareId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId, shareId } = req.params;
  const db = createServerDb();

  const { data: wf } = await db
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

  await db.from("workflow_shares").delete().eq("id", shareId).eq("workflow_id", workflowId);
  res.status(204).send();
});

// POST /workflows/:workflowId/share
workflowsRouter.post("/:workflowId/share", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const { emails, allow_edit } = req.body as { emails: string[]; allow_edit: boolean };

  if (!emails?.length) return void res.status(400).json({ detail: "emails is required" });

  const db = createServerDb();
  // Verify ownership
  const { data: wf } = await db
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const rows = emails.map((email: string) => ({
    workflow_id: workflowId,
    shared_by_user_id: userId,
    shared_with_email: email.trim().toLowerCase(),
    allow_edit: allow_edit ?? false,
  }));
  // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
  // person updates the existing row instead of stacking duplicates.
  const { error } = await db
    .from("workflow_shares")
    .upsert(rows, { onConflict: "workflow_id,shared_with_email" });
  if (error) return void res.status(500).json({ detail: error.message });

  res.status(204).send();
});
