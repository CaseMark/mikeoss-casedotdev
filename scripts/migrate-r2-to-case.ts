import "dotenv/config";
import crypto from "crypto";
import { createServerDb } from "../backend/src/lib/db";
import { getPostgresPool } from "../backend/src/lib/postgresCompat";
import {
  registerCaseStoredObject,
  syncDocumentVersionToCase,
} from "../backend/src/lib/caseSync";
import { isCaseStorageUri, uploadFile } from "../backend/src/lib/storage";

type VersionRow = {
  id: string;
  document_id: string;
  storage_path: string | null;
  pdf_storage_path: string | null;
  display_name: string | null;
};

type DocumentRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  filename: string;
  file_type: string;
};

const LEGACY_ENV_KEYS = [
  "R2_ENDPOINT_URL",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
] as const;

function requiredEnv(key: (typeof LEGACY_ENV_KEYS)[number]): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required for legacy R2 migration.`);
  return value;
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function awsDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

async function downloadLegacyR2Object(key: string): Promise<ArrayBuffer> {
  const endpoint = requiredEnv("R2_ENDPOINT_URL").replace(/\/+$/, "");
  const accessKey = requiredEnv("R2_ACCESS_KEY_ID");
  const secretKey = requiredEnv("R2_SECRET_ACCESS_KEY");
  const bucket = requiredEnv("R2_BUCKET_NAME");
  const region = process.env.R2_REGION?.trim() || "auto";
  const url = new URL(`${endpoint}/${encodeURIComponent(bucket)}/${encodeKeyPath(key)}`);
  const { amzDate, dateStamp } = awsDate();
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const canonicalHeaders = [
    `host:${url.host}`,
    "x-amz-content-sha256:UNSIGNED-PAYLOAD",
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "GET",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"),
    "aws4_request",
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");
  const response = await fetch(url, {
    headers: {
      Authorization: [
        `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`,
      ].join(", "),
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-date": amzDate,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`R2 download failed for ${key}: ${response.status} ${body.slice(0, 300)}`);
  }
  return response.arrayBuffer();
}

function contentTypeFor(filename: string, fileType?: string | null): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf") || fileType === "pdf") return "application/pdf";
  if (lower.endsWith(".doc") || lower.endsWith(".docx") || fileType === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/octet-stream";
}

function pdfNameFor(filename: string): string {
  const stem = filename.replace(/\.[^/.]+$/, "") || "document";
  return `${stem}.pdf`;
}

async function main() {
  for (const key of LEGACY_ENV_KEYS) requiredEnv(key);
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 0) : 0;
  const db = createServerDb();
  const { data } = await db
    .from("document_versions")
    .select("id, document_id, storage_path, pdf_storage_path, display_name")
    .order("created_at", { ascending: true });
  const rows = ((data ?? []) as VersionRow[]).filter(
    (row) =>
      (row.storage_path && !isCaseStorageUri(row.storage_path)) ||
      (row.pdf_storage_path && !isCaseStorageUri(row.pdf_storage_path)),
  );
  const selected = limit ? rows.slice(0, limit) : rows;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of selected) {
    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id, filename, file_type")
      .eq("id", row.document_id)
      .maybeSingle();
    if (!doc) {
      skipped++;
      console.log(`skip ${row.id}: document missing`);
      continue;
    }
    const document = doc as DocumentRow;
    const updates: Record<string, unknown> = {};
    try {
      let sourceBytes: ArrayBuffer | null = null;
      let sourceUri = row.storage_path;
      if (row.storage_path && !isCaseStorageUri(row.storage_path)) {
        console.log(`${dryRun ? "would migrate" : "migrating"} source ${row.storage_path}`);
        sourceBytes = await downloadLegacyR2Object(row.storage_path);
        if (!dryRun) {
          sourceUri = await uploadFile(
            row.storage_path,
            sourceBytes,
            contentTypeFor(document.filename, document.file_type),
            {
              db,
              userId: document.user_id,
              projectId: document.project_id,
              documentId: document.id,
              versionId: row.id,
              filename: row.display_name ?? document.filename,
              role: "source",
              autoIndex: true,
            },
          );
          updates.storage_path = sourceUri;
        }
      }

      if (row.pdf_storage_path && !isCaseStorageUri(row.pdf_storage_path)) {
        if (row.pdf_storage_path === row.storage_path && sourceUri) {
          updates.pdf_storage_path = sourceUri;
        } else {
          console.log(`${dryRun ? "would migrate" : "migrating"} PDF ${row.pdf_storage_path}`);
          const pdfBytes = await downloadLegacyR2Object(row.pdf_storage_path);
          if (!dryRun) {
            const pdfUri = await uploadFile(
              row.pdf_storage_path,
              pdfBytes,
              "application/pdf",
              {
                db,
                userId: document.user_id,
                projectId: document.project_id,
                documentId: document.id,
                versionId: row.id,
                filename: pdfNameFor(document.filename),
                role: "pdf_rendition",
                autoIndex: false,
              },
            );
            updates.pdf_storage_path = pdfUri;
            await registerCaseStoredObject({
              documentId: document.id,
              versionId: row.id,
              userId: document.user_id,
              projectId: document.project_id,
              storageUri: pdfUri,
              filename: pdfNameFor(document.filename),
              contentType: "application/pdf",
              bytes: pdfBytes,
              role: "pdf_rendition",
              db,
            });
          }
        }
      }

      if (!dryRun && Object.keys(updates).length) {
        await db
          .from("document_versions")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (sourceBytes) {
          await syncDocumentVersionToCase({
            documentId: document.id,
            versionId: row.id,
            userId: document.user_id,
            projectId: document.project_id,
            filename: row.display_name ?? document.filename,
            contentType: contentTypeFor(document.filename, document.file_type),
            bytes: sourceBytes,
            db,
          });
        }
      }
      migrated++;
    } catch (err) {
      failed++;
      console.error(`failed ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `R2 to Case migration complete: ${migrated} migrated, ${skipped} skipped, ${failed} failed.`,
  );
  await getPostgresPool().end();
}

main().catch(async (err) => {
  console.error(err);
  await getPostgresPool().end().catch(() => {});
  process.exit(1);
});
