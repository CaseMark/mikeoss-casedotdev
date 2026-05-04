import { Router } from "express";
import { createServerDb } from "../lib/db";

export const caseWebhooksRouter = Router();

function webhookAllowed(req: import("express").Request) {
    const secret = process.env.CASE_WEBHOOK_SHARED_SECRET?.trim();
    if (!secret) return true;
    const received =
        req.header("x-case-webhook-secret") ??
        req.header("x-mike-webhook-secret") ??
        "";
    return received === secret;
}

function eventObjectId(body: Record<string, unknown>) {
    return (
        (typeof body.objectId === "string" && body.objectId) ||
        (typeof body.resourceId === "string" && body.resourceId) ||
        (typeof body.object_id === "string" && body.object_id) ||
        (typeof (body.payload as Record<string, unknown> | undefined)?.objectId ===
            "string" &&
            ((body.payload as Record<string, unknown>).objectId as string)) ||
        null
    );
}

caseWebhooksRouter.post("/vault", async (req, res) => {
    if (!webhookAllowed(req)) return void res.status(401).json({ detail: "Unauthorized" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vaultId =
        (typeof body.vaultId === "string" && body.vaultId) ||
        (typeof body.vault_id === "string" && body.vault_id) ||
        null;
    const objectId = eventObjectId(body);
    const eventType = String(body.eventType ?? body.type ?? "");
    if (!vaultId || !objectId) {
        return void res.status(202).json({ ok: true, skipped: "missing vault/object id" });
    }

    const failed = eventType.includes("failed");
    const completed = eventType.includes("completed");
    const processing = eventType.includes("started") || eventType.includes("initiated");
    const db = createServerDb();
    const statusPatch: Record<string, unknown> = {};
    if (failed) {
        statusPatch.sync_status = "failed";
        statusPatch.ingestion_status = "failed";
    } else if (completed) {
        statusPatch.sync_status = "completed";
        statusPatch.ingestion_status = "completed";
    } else if (processing) {
        statusPatch.sync_status = "ingesting";
        statusPatch.ingestion_status = "processing";
    }
    await db
        .from("case_document_links")
        .update({
            ...statusPatch,
            error: failed
                ? String((body.payload as Record<string, unknown> | undefined)?.error ?? "Case.dev ingestion failed")
                : null,
            object_metadata: body,
            last_seen_at: new Date().toISOString(),
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq("case_vault_id", vaultId)
        .eq("case_object_id", objectId);
    res.json({ ok: true });
});

caseWebhooksRouter.post("/matters", async (req, res) => {
    if (!webhookAllowed(req)) return void res.status(401).json({ detail: "Unauthorized" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const matterId =
        (typeof body.matterId === "string" && body.matterId) ||
        (typeof body.matter_id === "string" && body.matter_id) ||
        (typeof body.resourceId === "string" && body.resourceId) ||
        null;
    if (!matterId) {
        return void res.status(202).json({ ok: true, skipped: "missing matter id" });
    }
    const payload = (body.payload as Record<string, unknown> | undefined) ?? {};
    const status =
        (typeof body.status === "string" && body.status) ||
        (typeof payload.status === "string" && payload.status) ||
        null;
    const db = createServerDb();
    await db
        .from("projects")
        .update({
            ...(status ? { matter_status: status } : {}),
            case_matter_metadata: payload,
            matter_sync_status: "active",
            matter_sync_error: null,
            matter_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq("case_matter_id", matterId);
    res.json({ ok: true });
});
