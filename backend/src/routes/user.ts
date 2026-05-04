import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerDb } from "../lib/db";
import {
  caseClientForEffectiveKey,
  clearCaseApiKey,
  getEffectiveCaseApiKey,
  getCaseCredentialStatus,
  saveCaseApiKey,
} from "../lib/caseCredentials";
import { FALLBACK_CASE_MODELS, getCaseModelCatalog } from "../lib/caseModels";
import { getDemoUsageStatus } from "../lib/demoUsage";

export const userRouter = Router();

type UserProfilePatch = {
  display_name?: unknown;
  organisation?: unknown;
  tabular_model?: unknown;
  message_credits_used?: unknown;
  credits_reset_date?: unknown;
};

async function ensureProfile(userId: string, db: ReturnType<typeof createServerDb>) {
  return db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
}

function profilePatch(body: UserProfilePatch) {
  const patch: Record<string, unknown> = {};
  if (typeof body.display_name === "string") {
    patch.display_name = body.display_name;
  }
  if (typeof body.organisation === "string") {
    patch.organisation = body.organisation;
  }
  if (typeof body.tabular_model === "string") {
    patch.tabular_model = body.tabular_model;
  }
  if (typeof body.message_credits_used === "number") {
    patch.message_credits_used = body.message_credits_used;
  }
  if (typeof body.credits_reset_date === "string") {
    patch.credits_reset_date = body.credits_reset_date;
  }
  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString();
  }
  return patch;
}

// POST /user/profile
userRouter.post("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const { error } = await ensureProfile(userId, db);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const ensured = await ensureProfile(userId, db);
  if (ensured.error) {
    return void res.status(500).json({ detail: ensured.error.message });
  }
  const { data, error } = await db
    .from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data);
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const ensured = await ensureProfile(userId, db);
  if (ensured.error) {
    return void res.status(500).json({ detail: ensured.error.message });
  }

  const patch = profilePatch(req.body ?? {});
  if (!Object.keys(patch).length) {
    const { data, error } = await db
      .from("user_profiles")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (error) return void res.status(500).json({ detail: error.message });
    return void res.json(data);
  }

  const { data, error } = await db
    .from("user_profiles")
    .update(patch)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data);
});

// GET /user/case-api-key — safe credential metadata only
userRouter.get("/case-api-key", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const status = await getCaseCredentialStatus(userId, db);
  res.json(status);
});

// GET /user/demo-usage — public-safe demo budget metadata for the signed-in user
userRouter.get("/demo-usage", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  try {
    res.json(await getDemoUsageStatus(userId, db));
  } catch (err) {
    res.status(500).json({
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// GET /user/case-models — live Case.dev model catalog when a key is available
userRouter.get("/case-models", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const effectiveKey = await getEffectiveCaseApiKey(userId, db);
  if (!effectiveKey) {
    res.json({
      source: "fallback",
      key_source: "missing",
      models: FALLBACK_CASE_MODELS,
      error: "Add a Case.dev API key to load the live model catalog.",
    });
    return;
  }
  try {
    const models = await getCaseModelCatalog(
      caseClientForEffectiveKey(effectiveKey, {
        userId,
        db,
        service: "llm",
        operation: "llm.model_catalog",
      }),
    );
    res.json({
      source: "live",
      key_source: effectiveKey.source,
      models,
    });
  } catch (err) {
    res.json({
      source: "fallback",
      key_source: effectiveKey.source,
      models: FALLBACK_CASE_MODELS,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// PUT /user/case-api-key
userRouter.put("/case-api-key", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const apiKey =
    typeof req.body?.api_key === "string" ? req.body.api_key.trim() : "";
  try {
    if (!apiKey) {
      res.json(await clearCaseApiKey(userId, db));
      return;
    }
    res.json(await saveCaseApiKey(userId, apiKey, db));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(400).json({ detail });
  }
});

// DELETE /user/case-api-key
userRouter.delete("/case-api-key", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  try {
    res.json(await clearCaseApiKey(userId, db));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(400).json({ detail });
  }
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerDb();
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});
