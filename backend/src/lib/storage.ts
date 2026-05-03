/**
 * Case Vault storage utilities for Mike document management.
 *
 * Mike keeps document metadata, permissions, and version history in Postgres.
 * Binary bytes live in Case Vault objects and are referenced from
 * document_versions.storage_path / pdf_storage_path as opaque case:// URIs.
 */

import crypto from "crypto";
import type { createServerDb } from "./db";
import { CaseClient } from "./caseClient";
import { getEffectiveCaseApiKey } from "./caseCredentials";

type Db = ReturnType<typeof createServerDb>;

export type CaseBlobRole = "source" | "pdf_rendition" | "generated";

export type StorageContext = {
  db: Db;
  userId?: string;
  projectId?: string | null;
  filename?: string;
  documentId?: string | null;
  versionId?: string | null;
  role?: CaseBlobRole;
  autoIndex?: boolean;
  path?: string | null;
};

type VaultLink = {
  id: string;
  owner_user_id: string;
  project_id: string | null;
  scope: "personal" | "project";
  case_vault_id: string;
  name: string;
};

export type CaseStorageRef = {
  vaultId: string;
  objectId: string;
};

export class LegacyStorageObjectError extends Error {
  path: string;

  constructor(path: string) {
    super(
      "This document still points to legacy R2 storage. Run the optional R2-to-Case migration before opening it.",
    );
    this.path = path;
  }
}

export const CASE_STORAGE_PREFIX = "case://vault/";

export const storageEnabled = true;

export function isCaseStorageUri(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(CASE_STORAGE_PREFIX);
}

export function buildCaseStorageUri(vaultId: string, objectId: string): string {
  return `${CASE_STORAGE_PREFIX}${encodeURIComponent(vaultId)}/objects/${encodeURIComponent(objectId)}`;
}

export function parseCaseStorageUri(value: string): CaseStorageRef | null {
  if (!isCaseStorageUri(value)) return null;
  const match = value.match(/^case:\/\/vault\/([^/]+)\/objects\/([^/]+)$/);
  if (!match) return null;
  return {
    vaultId: decodeURIComponent(match[1]),
    objectId: decodeURIComponent(match[2]),
  };
}

function bytesView(content: ArrayBuffer | Buffer): Uint8Array {
  return content instanceof Buffer
    ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
    : new Uint8Array(content);
}

export function hashBytes(content: ArrayBuffer | Buffer): string {
  return crypto.createHash("sha256").update(bytesView(content)).digest("hex");
}

function sizeOf(content: ArrayBuffer | Buffer): number {
  return content instanceof Buffer ? content.byteLength : content.byteLength;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findCaseVaultLink(params: {
  db: Db;
  ownerUserId: string;
  projectId?: string | null;
}): Promise<VaultLink | null> {
  const query = params.projectId
    ? params.db
        .from("case_vault_links")
        .select("*")
        .eq("scope", "project")
        .eq("project_id", params.projectId)
        .maybeSingle()
    : params.db
        .from("case_vault_links")
        .select("*")
        .eq("scope", "personal")
        .eq("owner_user_id", params.ownerUserId)
        .maybeSingle();
  const { data } = await query;
  return data?.case_vault_id ? (data as VaultLink) : null;
}

async function findCaseVaultLinkWithRetry(params: {
  db: Db;
  ownerUserId: string;
  projectId?: string | null;
}): Promise<VaultLink | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const link = await findCaseVaultLink(params);
    if (link) return link;
    await sleep(100 * (attempt + 1));
  }
  return null;
}

function isCaseVaultLinkUniqueViolation(message: string | undefined) {
  if (!message) return false;
  return (
    message.includes("duplicate key value violates unique constraint") &&
    (message.includes("case_vault_links_personal_unique") ||
      message.includes("case_vault_links_project_unique"))
  );
}

async function ownerForStorage(params: {
  db: Db;
  userId: string;
  projectId?: string | null;
}): Promise<{ ownerUserId: string; projectName?: string | null }> {
  if (!params.projectId) return { ownerUserId: params.userId };
  const { data: project } = await params.db
    .from("projects")
    .select("user_id, name")
    .eq("id", params.projectId)
    .maybeSingle();
  return {
    ownerUserId: String(project?.user_id ?? params.userId),
    projectName: (project?.name as string | null | undefined) ?? null,
  };
}

export async function ensureCaseVaultLink(params: {
  db: Db;
  ownerUserId: string;
  projectId?: string | null;
  projectName?: string | null;
  client: CaseClient;
}): Promise<VaultLink> {
  const existing = await findCaseVaultLink(params);
  if (existing) return existing;

  const scope = params.projectId ? "project" : "personal";
  const name = params.projectId
    ? `Mike project: ${params.projectName ?? params.projectId}`
    : "Mike personal documents";
  const vault = await params.client.createVault({
    name,
    description:
      scope === "project"
        ? "Canonical Mike project document storage and Case.dev search/RAG."
        : "Canonical Mike standalone document storage and Case.dev search/RAG.",
    enableGraph: true,
    enableIndexing: true,
    metadata: {
      source: "mike",
      mike_scope: scope,
      mike_owner_user_id: params.ownerUserId,
      mike_project_id: params.projectId ?? null,
    },
  });

  const { data, error } = await params.db
    .from("case_vault_links")
    .insert({
      owner_user_id: params.ownerUserId,
      project_id: params.projectId ?? null,
      scope,
      case_vault_id: vault.id,
      name,
      status: "active",
      error: null,
    })
    .select("*")
    .single();
  if (error || !data) {
    if (isCaseVaultLinkUniqueViolation(error?.message)) {
      const concurrent = await findCaseVaultLinkWithRetry(params);
      if (concurrent) {
        console.warn(
          "[case-storage] reused concurrently-created Case vault link after unique constraint race",
          {
            scope,
            ownerUserId: params.ownerUserId,
            projectId: params.projectId ?? null,
            unusedVaultId: vault.id,
            reusedVaultId: concurrent.case_vault_id,
          },
        );
        return concurrent;
      }
    }
    throw new Error(error?.message ?? "Failed to record Case vault link.");
  }
  return data as VaultLink;
}

async function clientForVault(
  vaultId: string,
  db: Db,
): Promise<{ client: CaseClient; vaultLink: VaultLink | null }> {
  const { data: link } = await db
    .from("case_vault_links")
    .select("*")
    .eq("case_vault_id", vaultId)
    .maybeSingle();
  const vaultLink = (link as VaultLink | null) ?? null;
  const ownerUserId = vaultLink?.owner_user_id;
  if (!ownerUserId) {
    const fallback = process.env.CASE_API_KEY?.trim();
    if (fallback) return { client: new CaseClient(fallback), vaultLink: null };
    throw new Error("Case Vault owner key is not available for this object.");
  }
  const effective = await getEffectiveCaseApiKey(ownerUserId, db);
  if (!effective) {
    throw new Error("Case Vault owner has not configured a verified Case.dev API key.");
  }
  return { client: new CaseClient(effective.apiKey), vaultLink };
}

async function clientForNewUpload(context: StorageContext): Promise<{
  client: CaseClient;
  vaultLink: VaultLink;
}> {
  if (!context.userId) {
    throw new Error("Case Vault uploads require a userId in storage context.");
  }
  const owner = await ownerForStorage({
    db: context.db,
    userId: context.userId,
    projectId: context.projectId ?? null,
  });
  const effective = await getEffectiveCaseApiKey(owner.ownerUserId, context.db);
  if (!effective) {
    throw new Error("Add a Case.dev API key with Vault access before uploading documents.");
  }
  const client = new CaseClient(effective.apiKey);
  const vaultLink = await ensureCaseVaultLink({
    db: context.db,
    ownerUserId: owner.ownerUserId,
    projectId: context.projectId ?? null,
    projectName: owner.projectName,
    client,
  });
  return { client, vaultLink };
}

function filenameFromKey(key: string): string {
  const stripped = key.split("?")[0];
  const last = stripped.split("/").filter(Boolean).pop();
  return last || "document.bin";
}

function resolvedPresignedUrl(value: unknown): string {
  const record = value as {
    presignedUrl?: string;
    uploadUrl?: string;
    downloadUrl?: string;
    url?: string;
  };
  const url =
    record.presignedUrl ?? record.uploadUrl ?? record.downloadUrl ?? record.url;
  if (!url) throw new Error("Case.dev did not return a presigned object URL.");
  return url;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  keyOrUri: string,
  content: ArrayBuffer | Buffer,
  contentType: string,
  context?: StorageContext,
): Promise<string> {
  if (isCaseStorageUri(keyOrUri)) {
    if (!context?.db) {
      throw new Error("Updating a Case Vault object requires storage context.");
    }
    const ref = parseCaseStorageUri(keyOrUri);
    if (!ref) throw new Error("Invalid Case Vault storage URI.");
    const { client } = await clientForVault(ref.vaultId, context.db);
    const presigned = await client.createVaultObjectPresignedUrl({
      vaultId: ref.vaultId,
      objectId: ref.objectId,
      operation: "PUT",
      contentType,
      sizeBytes: sizeOf(content),
      expiresIn: 3600,
    });
    await client.uploadToPresignedUrl(resolvedPresignedUrl(presigned), content, contentType);
    if (context.autoIndex ?? context.role !== "pdf_rendition") {
      await client.ingestVaultObject(ref.vaultId, ref.objectId).catch(() => {});
    }
    return keyOrUri;
  }

  if (!context?.db) {
    throw new LegacyStorageObjectError(keyOrUri);
  }

  const { client, vaultLink } = await clientForNewUpload(context);
  const filename = context.filename ?? filenameFromKey(keyOrUri);
  const upload = await client.createVaultUpload({
    vaultId: vaultLink.case_vault_id,
    filename,
    contentType,
    sizeBytes: sizeOf(content),
    path: context.path ?? keyOrUri,
    auto_index: context.autoIndex ?? context.role !== "pdf_rendition",
    metadata: {
      source: "mike",
      mike_storage_role: context.role ?? "source",
      mike_logical_path: keyOrUri,
      mike_document_id: context.documentId ?? null,
      mike_version_id: context.versionId ?? null,
      mike_project_id: context.projectId ?? null,
      content_hash: hashBytes(content),
    },
  });
  const { etag } = await client.uploadToPresignedUrl(
    resolvedPresignedUrl(upload),
    content,
    contentType,
  );
  await client.confirmVaultUpload({
    vaultId: vaultLink.case_vault_id,
    objectId: upload.objectId,
    success: true,
    sizeBytes: sizeOf(content),
    etag,
  });
  return buildCaseStorageUri(vaultLink.case_vault_id, upload.objectId);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(
  uri: string,
  context?: { db?: Db },
): Promise<ArrayBuffer | null> {
  const ref = parseCaseStorageUri(uri);
  if (!ref) throw new LegacyStorageObjectError(uri);
  if (!context?.db) {
    throw new Error("Downloading a Case Vault object requires storage context.");
  }
  try {
    const { client } = await clientForVault(ref.vaultId, context.db);
    return await client.downloadVaultObject(ref.vaultId, ref.objectId);
  } catch (err) {
    console.error("[case-storage] download failed", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(
  uri: string,
  context?: { db?: Db },
): Promise<void> {
  const ref = parseCaseStorageUri(uri);
  if (!ref) return;
  if (!context?.db) return;
  const { client } = await clientForVault(ref.vaultId, context.db);
  await client.deleteVaultObject(ref.vaultId, ref.objectId);
}

// ---------------------------------------------------------------------------
// Signed URL (temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  uri: string,
  expiresIn = 3600,
  _downloadFilename?: string,
  context?: { db?: Db },
): Promise<string | null> {
  const ref = parseCaseStorageUri(uri);
  if (!ref) throw new LegacyStorageObjectError(uri);
  if (!context?.db) {
    throw new Error("Creating a Case Vault signed URL requires storage context.");
  }
  try {
    const { client } = await clientForVault(ref.vaultId, context.db);
    const presigned = await client.createVaultObjectPresignedUrl({
      vaultId: ref.vaultId,
      objectId: ref.objectId,
      operation: "GET",
      expiresIn,
    });
    return resolvedPresignedUrl(presigned);
  } catch {
    return null;
  }
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name).replace(/["\\]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

// ---------------------------------------------------------------------------
// Logical path helpers, retained for stable metadata/path organization.
// ---------------------------------------------------------------------------

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
