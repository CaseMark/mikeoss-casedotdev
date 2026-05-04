import crypto from "crypto";
import type { createServerDb } from "./db";
import {
  demoBudgetLimitMicros,
  demoEstimateConfig,
  demoGlobalBudgetLimitMicros,
  estimateVaultUploadMicros,
  isDemoModeEnabled,
  microsToUsd,
} from "./demoMode";

type Db = ReturnType<typeof createServerDb>;

export type DemoUsageService =
  | "llm"
  | "vault"
  | "legal"
  | "skills"
  | "matters"
  | "usage"
  | "other";

export type DemoUsageContext = {
  userId: string;
  db: Db;
  source?: "user" | "server" | "demo";
  service?: DemoUsageService;
  operation?: string;
};

export type DemoUsageReservation = {
  requestId: string;
  userId: string;
  db: Db;
  service: DemoUsageService;
  operation: string;
  estimatedMicros: number;
};

export class DemoBudgetExceededError extends Error {
  code = "demo_budget_exceeded";
  status = 402;

  constructor(message = "Demo budget exhausted for this user.") {
    super(message);
  }
}

export type UsageFields = {
  cost?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  totalTokens?: unknown;
};

export type DemoUsageStatus = {
  enabled: boolean;
  limit_usd: number;
  spent_usd: number;
  reserved_usd: number;
  remaining_usd: number;
  blocked: boolean;
  global_remaining_usd?: number | null;
};

function jsonParam(value: unknown) {
  return JSON.stringify(value ?? {});
}

function normalizeMicros(value: number) {
  return Math.max(0, Math.round(value));
}

function statusFromRow(row: {
  limit_usd_micros: number | string;
  spent_usd_micros: number | string;
  reserved_usd_micros: number | string;
  blocked_at?: string | null;
}): DemoUsageStatus {
  const limit = Number(row.limit_usd_micros ?? 0);
  const spent = Number(row.spent_usd_micros ?? 0);
  const reserved = Number(row.reserved_usd_micros ?? 0);
  const remaining = Math.max(0, limit - spent - reserved);
  return {
    enabled: isDemoModeEnabled(),
    limit_usd: microsToUsd(limit),
    spent_usd: microsToUsd(spent),
    reserved_usd: microsToUsd(reserved),
    remaining_usd: microsToUsd(remaining),
    blocked: remaining <= 0,
  };
}

export function isDemoBudgetError(err: unknown): err is DemoBudgetExceededError {
  return (
    err instanceof DemoBudgetExceededError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "demo_budget_exceeded")
  );
}

export function demoBudgetErrorPayload(err: unknown) {
  const message =
    err instanceof Error
      ? err.message
      : "Demo budget exhausted for this user.";
  return {
    type: "error",
    code: "demo_budget_exceeded",
    message,
  };
}

async function ensureUserUsage(userId: string, db: Db) {
  await db.query(
    `insert into public.demo_user_usage (user_id, limit_usd_micros)
     values ($1, $2)
     on conflict (user_id) do nothing`,
    [userId, demoBudgetLimitMicros()],
  );
}

async function globalRemainingMicros(db: Db): Promise<number | null> {
  const limit = demoGlobalBudgetLimitMicros();
  if (limit === null) return null;
  const result = await db.query<{ spent: string | number; reserved: string | number }>(
    `select
       coalesce(sum(spent_usd_micros), 0)::bigint as spent,
       coalesce(sum(reserved_usd_micros), 0)::bigint as reserved
     from public.demo_user_usage`,
  );
  const row = result.rows[0];
  const used = Number(row?.spent ?? 0) + Number(row?.reserved ?? 0);
  return Math.max(0, limit - used);
}

async function assertGlobalBudget(db: Db, estimateMicros: number) {
  const remaining = await globalRemainingMicros(db);
  if (remaining !== null && remaining < estimateMicros) {
    throw new DemoBudgetExceededError(
      "The shared demo budget is temporarily exhausted.",
    );
  }
}

export async function getDemoUsageStatus(
  userId: string,
  db: Db,
): Promise<DemoUsageStatus> {
  if (!isDemoModeEnabled()) {
    return {
      enabled: false,
      limit_usd: 0,
      spent_usd: 0,
      reserved_usd: 0,
      remaining_usd: 0,
      blocked: false,
      global_remaining_usd: null,
    };
  }
  await ensureUserUsage(userId, db);
  const result = await db.query<{
    limit_usd_micros: string | number;
    spent_usd_micros: string | number;
    reserved_usd_micros: string | number;
    blocked_at: string | null;
  }>(
    `select limit_usd_micros, spent_usd_micros, reserved_usd_micros, blocked_at
     from public.demo_user_usage
     where user_id = $1`,
    [userId],
  );
  const row = result.rows[0] ?? {
    limit_usd_micros: demoBudgetLimitMicros(),
    spent_usd_micros: 0,
    reserved_usd_micros: 0,
    blocked_at: null,
  };
  const status = statusFromRow(row);
  const globalRemaining = await globalRemainingMicros(db);
  status.global_remaining_usd =
    globalRemaining === null ? null : microsToUsd(globalRemaining);
  return status;
}

export async function reserveDemoUsage(params: {
  context?: DemoUsageContext | null;
  service: DemoUsageService;
  operation: string;
  estimateMicros: number;
  model?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<DemoUsageReservation | null> {
  const context = params.context;
  if (!isDemoModeEnabled() || context?.source !== "demo" || !context.userId) {
    return null;
  }
  const estimateMicros = normalizeMicros(params.estimateMicros);
  if (estimateMicros <= 0) return null;

  await ensureUserUsage(context.userId, context.db);
  await assertGlobalBudget(context.db, estimateMicros);

  const requestId = crypto.randomUUID();
  const result = await context.db.query(
    `update public.demo_user_usage
       set reserved_usd_micros = reserved_usd_micros + $2,
           blocked_at = null,
           updated_at = now()
     where user_id = $1
       and spent_usd_micros + reserved_usd_micros + $2 <= limit_usd_micros
     returning user_id`,
    [context.userId, estimateMicros],
  );
  if (!result.rowCount) {
    await context.db.query(
      `update public.demo_user_usage
          set blocked_at = coalesce(blocked_at, now()),
              updated_at = now()
        where user_id = $1`,
      [context.userId],
    );
    throw new DemoBudgetExceededError();
  }

  await context.db.query(
    `insert into public.demo_usage_events
       (request_id, user_id, case_source, status, operation, service, model,
        estimated_usd_micros, metadata)
     values ($1, $2, 'demo', 'reserved', $3, $4, $5, $6, $7::jsonb)`,
    [
      requestId,
      context.userId,
      params.operation,
      params.service,
      params.model ?? null,
      estimateMicros,
      jsonParam(params.metadata),
    ],
  );

  return {
    requestId,
    userId: context.userId,
    db: context.db,
    service: params.service,
    operation: params.operation,
    estimatedMicros: estimateMicros,
  };
}

export async function commitDemoUsage(
  reservation: DemoUsageReservation | null,
  params: {
    actualMicros?: number | null;
    model?: string | null;
    usage?: UsageFields | null;
    units?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } = {},
) {
  if (!reservation) return;
  const actualFromUsage = costMicrosFromUsage(params.usage);
  const actualMicros =
    params.actualMicros !== undefined && params.actualMicros !== null
      ? normalizeMicros(params.actualMicros)
      : actualFromUsage;
  const fallbackMicros =
    reservation.service === "llm"
      ? demoEstimateConfig().llmUnknownMicros
      : reservation.estimatedMicros;
  const chargedMicros = normalizeMicros(
    actualMicros ?? fallbackMicros,
  );
  const promptTokens =
    numberFromUnknown(params.usage?.prompt_tokens) ??
    numberFromUnknown(params.usage?.promptTokens);
  const completionTokens =
    numberFromUnknown(params.usage?.completion_tokens) ??
    numberFromUnknown(params.usage?.completionTokens);
  const totalTokens =
    numberFromUnknown(params.usage?.total_tokens) ??
    numberFromUnknown(params.usage?.totalTokens);

  await reservation.db.query(
    `update public.demo_user_usage
       set reserved_usd_micros = greatest(0, reserved_usd_micros - $2),
           spent_usd_micros = spent_usd_micros + $3,
           blocked_at = case
             when spent_usd_micros + $3 >= limit_usd_micros then coalesce(blocked_at, now())
             else blocked_at
           end,
           updated_at = now()
     where user_id = $1`,
    [reservation.userId, reservation.estimatedMicros, chargedMicros],
  );
  await reservation.db.query(
    `update public.demo_usage_events
       set status = 'charged',
           actual_usd_micros = $2,
           charged_usd_micros = $3,
           model = coalesce($4, model),
           prompt_tokens = $5,
           completion_tokens = $6,
           total_tokens = $7,
           units = $8::jsonb,
           metadata = metadata || $9::jsonb,
           updated_at = now()
     where request_id = $1`,
    [
      reservation.requestId,
      actualMicros ?? null,
      chargedMicros,
      params.model ?? null,
      promptTokens ?? null,
      completionTokens ?? null,
      totalTokens ?? null,
      jsonParam(params.units),
      jsonParam(params.metadata),
    ],
  );
}

export async function releaseDemoUsage(
  reservation: DemoUsageReservation | null,
  params: {
    chargeEstimate?: boolean;
    metadata?: Record<string, unknown>;
  } = {},
) {
  if (!reservation) return;
  if (params.chargeEstimate) {
    await commitDemoUsage(reservation, {
      actualMicros: reservation.estimatedMicros,
      metadata: params.metadata,
    });
    return;
  }
  await reservation.db.query(
    `update public.demo_user_usage
       set reserved_usd_micros = greatest(0, reserved_usd_micros - $2),
           updated_at = now()
     where user_id = $1`,
    [reservation.userId, reservation.estimatedMicros],
  );
  await reservation.db.query(
    `update public.demo_usage_events
       set status = 'released',
           charged_usd_micros = 0,
           metadata = metadata || $2::jsonb,
           updated_at = now()
     where request_id = $1`,
    [reservation.requestId, jsonParam(params.metadata)],
  );
}

export function costMicrosFromUsage(usage?: UsageFields | null): number | null {
  const cost = numberFromUnknown(usage?.cost);
  return cost !== null ? normalizeMicros(cost * 1_000_000) : null;
}

export function estimateLlmUsageCostMicros(
  usage: UsageFields | null | undefined,
  pricing: Record<string, unknown> | null | undefined,
): number | null {
  const promptTokens =
    numberFromUnknown(usage?.prompt_tokens) ??
    numberFromUnknown(usage?.promptTokens);
  const completionTokens =
    numberFromUnknown(usage?.completion_tokens) ??
    numberFromUnknown(usage?.completionTokens);
  const inputPrice = pricingValue(pricing, [
    "input",
    "prompt",
    "prompt_tokens",
    "input_tokens",
    "input_token",
  ]);
  const outputPrice = pricingValue(pricing, [
    "output",
    "completion",
    "completion_tokens",
    "output_tokens",
    "output_token",
  ]);

  if (promptTokens === null && completionTokens === null) return null;
  if (inputPrice === null && outputPrice === null) return null;

  const inputCost = (promptTokens ?? 0) * (inputPrice ?? 0);
  const outputCost = (completionTokens ?? 0) * (outputPrice ?? 0);
  return normalizeMicros((inputCost + outputCost) * 1_000_000);
}

export function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim().replace(/^\$/, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pricingValue(
  pricing: Record<string, unknown> | null | undefined,
  keys: string[],
): number | null {
  if (!pricing) return null;
  for (const key of keys) {
    const value = numberFromUnknown(pricing[key]);
    if (value !== null) return value;
  }
  return null;
}

export function usageFromResponse(value: unknown): UsageFields | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return usage as UsageFields;
}

export function estimateCaseOperation(params: {
  path: string;
  method?: string;
  json?: unknown;
  service?: DemoUsageService;
  operation?: string;
}): {
  service: DemoUsageService;
  operation: string;
  estimateMicros: number;
  metadata: Record<string, unknown>;
} {
  const config = demoEstimateConfig();
  const path = params.path;
  const method = params.method?.toUpperCase() ?? "GET";
  const metadata: Record<string, unknown> = { path, method };

  const withOverride = (inferred: {
    service: DemoUsageService;
    operation: string;
    estimateMicros: number;
    metadata: Record<string, unknown>;
  }) => ({
    ...inferred,
    service: params.service ?? inferred.service,
    operation: params.operation ?? inferred.operation,
  });

  if (path.startsWith("/llm/")) {
    return withOverride({
      service: "llm",
      operation: path.includes("/chat/completions")
        ? "llm.chat_completions"
        : "llm.metadata",
      estimateMicros: path.includes("/chat/completions")
        ? config.llmReserveMicros
        : config.otherCallMicros,
      metadata,
    });
  }
  if (path.startsWith("/legal/")) {
    return withOverride({
      service: "legal",
      operation: legalOperation(path),
      estimateMicros: config.legalCallMicros,
      metadata,
    });
  }
  if (path.startsWith("/skills")) {
    return withOverride({
      service: "skills",
      operation: "skills.catalog",
      estimateMicros: config.skillsCallMicros,
      metadata,
    });
  }
  if (path.startsWith("/matters/")) {
    return withOverride({
      service: "matters",
      operation: "matters.metadata",
      estimateMicros: config.mattersCallMicros,
      metadata,
    });
  }
  if (path.startsWith("/vault")) {
    const sizeBytes = sizeBytesFromJson(params.json);
    const upload = path.includes("/upload") || method === "PUT";
    return withOverride({
      service: "vault",
      operation: upload ? "vault.upload_ingest" : "vault.operation",
      estimateMicros: upload
        ? estimateVaultUploadMicros(sizeBytes)
        : config.vaultCallMicros,
      metadata: { ...metadata, size_bytes: sizeBytes ?? null },
    });
  }
  return withOverride({
    service: "other",
    operation: "case.request",
    estimateMicros: config.otherCallMicros,
    metadata,
  });
}

function legalOperation(path: string) {
  const tail = path.replace(/^\/legal\/v1\/?/, "").split("?")[0] || "request";
  return `legal.${tail.replace(/[^a-z0-9_-]+/gi, "_")}`;
}

function sizeBytesFromJson(json: unknown): number | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  return numberFromUnknown(record.sizeBytes) ?? numberFromUnknown(record.size_bytes);
}
