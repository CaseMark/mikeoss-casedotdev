import crypto from "crypto";
import type { createServerDb } from "./db";
import {
    CaseApiError,
    CaseClient,
    type CaseMatter,
    type CaseMatterLogEntry,
    type CaseMatterWorkItem,
} from "./caseClient";
import { caseClientForEffectiveKey, getEffectiveCaseApiKey } from "./caseCredentials";
import { ensureCaseVaultLink } from "./storage";

type Db = ReturnType<typeof createServerDb>;

type ProjectCache = {
    id: string;
    user_id: string;
    name: string;
    cm_number?: string | null;
    shared_with?: unknown;
    case_matter_id?: string | null;
    case_primary_vault_id?: string | null;
    matter_status?: string | null;
    practice_area?: string | null;
    matter_type?: string | null;
    client_name?: string | null;
    responsible_attorney?: string | null;
    case_matter_metadata?: Record<string, unknown> | null;
};

type CaseMatterCreatePayload = Parameters<CaseClient["createMatter"]>[0];

export type MatterBackedProjectInput = {
    name: string;
    cm_number?: string | null;
    shared_with?: string[];
    practice_area?: string | null;
    matter_type?: string | null;
    client_name?: string | null;
    responsible_attorney?: string | null;
};

export function mikeMatterDisplayId(projectId: string, cmNumber?: string | null) {
    return cmNumber?.trim() || `mike-${projectId}`;
}

export function primaryVaultIdForMatter(matter: CaseMatter): string | null {
    return (
        matter.primary_vault_id ??
        matter.vault_id ??
        (typeof matter.vaultId === "string" ? matter.vaultId : null) ??
        null
    );
}

function matterCacheFields(matter: CaseMatter, fallbackVaultId?: string | null) {
    return {
        case_matter_id: matter.id,
        case_primary_vault_id: primaryVaultIdForMatter(matter) ?? fallbackVaultId ?? null,
        matter_status: matter.status ?? "open",
        practice_area: matter.practice_area ?? null,
        matter_type: matter.matter_type ?? null,
        client_name: matter.client_name ?? null,
        responsible_attorney:
            matter.responsible_attorney_id ??
            (typeof matter.responsible_attorney === "string"
                ? matter.responsible_attorney
                : null),
        case_matter_metadata: matter.metadata ?? {},
        matter_sync_status: "active",
        matter_sync_error: null,
        matter_synced_at: new Date().toISOString(),
    };
}

function matterPayloadForProject(params: {
    projectId: string;
    ownerUserId: string;
    name: string;
    cmNumber?: string | null;
    vaultId?: string | null;
    practiceArea?: string | null;
    matterType?: string | null;
    clientName?: string | null;
    responsibleAttorney?: string | null;
}): CaseMatterCreatePayload {
    const responsibleAttorney = params.responsibleAttorney?.trim() || null;
    const responsibleAttorneyId =
        responsibleAttorney &&
        (/^[a-z]+_[A-Za-z0-9_-]+$/.test(responsibleAttorney) ||
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                responsibleAttorney,
            ))
            ? responsibleAttorney
            : null;
    const payload: CaseMatterCreatePayload = {
        title: params.name,
        display_id: mikeMatterDisplayId(params.projectId, params.cmNumber),
        status: "open",
        metadata: {
            source: "mike",
            mike_project_id: params.projectId,
            mike_owner_user_id: params.ownerUserId,
            responsible_attorney_name: responsibleAttorneyId
                ? null
                : responsibleAttorney,
        },
        custom_fields: {
            mike_project_id: params.projectId,
            mike_cm_number: params.cmNumber ?? null,
            responsible_attorney_name: responsibleAttorneyId
                ? null
                : responsibleAttorney,
        },
    };
    if (params.matterType) payload.matter_type = params.matterType;
    if (params.practiceArea) payload.practice_area = params.practiceArea;
    if (params.clientName) payload.client_name = params.clientName;
    if (params.vaultId) payload.vault_id = params.vaultId;
    if (responsibleAttorneyId) {
        payload.responsible_attorney_id = responsibleAttorneyId;
    }
    return payload;
}

async function createMatterWithDisplayRetry(
    client: CaseClient,
    payload: ReturnType<typeof matterPayloadForProject>,
): Promise<CaseMatter> {
    try {
        return await client.createMatter(payload);
    } catch (err) {
        if (
            err instanceof CaseApiError &&
            err.status === 409 &&
            payload.display_id
        ) {
            return client.createMatter({
                ...payload,
                display_id: `${payload.display_id}-${crypto.randomUUID().slice(0, 8)}`,
            });
        }
        throw err;
    }
}

export async function createMatterBackedProject(params: {
    db: Db;
    userId: string;
    input: MatterBackedProjectInput;
}): Promise<ProjectCache> {
    const name = params.input.name.trim();
    if (!name) throw new Error("name is required");

    const effective = await getEffectiveCaseApiKey(params.userId, params.db);
    if (!effective) {
        throw new Error("Add a Case.dev API key with Matters and Vault access before creating a matter.");
    }

    const projectId = crypto.randomUUID();
    const client = caseClientForEffectiveKey(effective, {
        userId: params.userId,
        db: params.db,
        service: "matters",
        operation: "matters.create",
    });
    const vault = await client.createVault({
        name: `Mike matter: ${name}`,
        description: "Primary Case.dev Vault for a Mike matter.",
        enableGraph: true,
        enableIndexing: true,
        metadata: {
            source: "mike",
            mike_scope: "matter",
            mike_owner_user_id: params.userId,
            mike_project_id: projectId,
        },
    });
    const matter = await createMatterWithDisplayRetry(
        client,
        matterPayloadForProject({
            projectId,
            ownerUserId: params.userId,
            name,
            cmNumber: params.input.cm_number,
            vaultId: vault.id,
            practiceArea: params.input.practice_area,
            matterType: params.input.matter_type,
            clientName: params.input.client_name,
            responsibleAttorney: params.input.responsible_attorney,
        }),
    );
    const vaultId = primaryVaultIdForMatter(matter) ?? vault.id;
    const now = new Date().toISOString();

    const { data, error } = await params.db
        .from("projects")
        .insert({
            id: projectId,
            user_id: params.userId,
            name,
            cm_number: params.input.cm_number ?? null,
            shared_with: params.input.shared_with ?? [],
            ...matterCacheFields(matter, vaultId),
            created_at: now,
            updated_at: now,
        })
        .select("*")
        .single();
    if (error || !data) {
        throw new Error(error?.message ?? "Failed to cache Case matter locally.");
    }

    await params.db.from("case_vault_links").insert({
        owner_user_id: params.userId,
        project_id: projectId,
        scope: "project",
        case_vault_id: vaultId,
        name: `Mike matter: ${name}`,
        status: "active",
        error: null,
    });

    await client
        .createMatterLogEntry(matter.id, {
            event_type: "mike.matter.created",
            summary: "Matter created from Mike.",
            details: { mike_project_id: projectId },
        })
        .catch(() => {});

    return data as ProjectCache;
}

export async function ensureCaseMatterForProject(params: {
    db: Db;
    project: ProjectCache;
}): Promise<ProjectCache> {
    if (params.project.case_matter_id) return params.project;

    const effective = await getEffectiveCaseApiKey(
        params.project.user_id,
        params.db,
    ).catch(() => null);
    if (!effective) {
        await params.db
            .from("projects")
            .update({
                matter_sync_status: "failed",
                matter_sync_error:
                    "Project owner has not configured a Case.dev API key with Matters access.",
                updated_at: new Date().toISOString(),
            })
            .eq("id", params.project.id);
        return params.project;
    }

    const client = caseClientForEffectiveKey(effective, {
        userId: params.project.user_id,
        db: params.db,
        service: "matters",
        operation: "matters.ensure",
    });
    const vaultLink = await ensureCaseVaultLink({
        db: params.db,
        ownerUserId: params.project.user_id,
        projectId: params.project.id,
        projectName: params.project.name,
        client,
    });
    const matter = await createMatterWithDisplayRetry(
        client,
        matterPayloadForProject({
            projectId: params.project.id,
            ownerUserId: params.project.user_id,
            name: params.project.name,
            cmNumber: params.project.cm_number,
            vaultId: vaultLink.case_vault_id,
            practiceArea: params.project.practice_area,
            matterType: params.project.matter_type,
            clientName: params.project.client_name,
            responsibleAttorney: params.project.responsible_attorney,
        }),
    );
    const fields = matterCacheFields(matter, vaultLink.case_vault_id);
    const { data, error } = await params.db
        .from("projects")
        .update({
            ...fields,
            updated_at: new Date().toISOString(),
        })
        .eq("id", params.project.id)
        .select("*")
        .single();
    if (error || !data) return { ...params.project, ...fields };
    return data as ProjectCache;
}

export async function syncCaseMatterUpdateForProject(params: {
    db: Db;
    project: ProjectCache;
    updates: Partial<MatterBackedProjectInput & { status: string }>;
}): Promise<CaseMatter | null> {
    const ensured = await ensureCaseMatterForProject({
        db: params.db,
        project: params.project,
    });
    if (!ensured.case_matter_id) return null;
    const effective = await getEffectiveCaseApiKey(ensured.user_id, params.db);
    if (!effective) return null;
    const client = caseClientForEffectiveKey(effective, {
        userId: ensured.user_id,
        db: params.db,
        service: "matters",
        operation: "matters.update",
    });
    const matter = await client.updateMatter(ensured.case_matter_id, {
        ...(params.updates.name !== undefined && { title: params.updates.name }),
        ...(params.updates.cm_number !== undefined && {
            display_id: mikeMatterDisplayId(ensured.id, params.updates.cm_number),
        }),
        ...(params.updates.status !== undefined && { status: params.updates.status }),
        ...(params.updates.practice_area !== undefined && {
            practice_area: params.updates.practice_area,
        }),
        ...(params.updates.matter_type !== undefined && {
            matter_type: params.updates.matter_type,
        }),
        ...(params.updates.client_name !== undefined && {
            client_name: params.updates.client_name,
        }),
        ...(params.updates.responsible_attorney !== undefined && {
            responsible_attorney_id: params.updates.responsible_attorney,
        }),
        metadata: {
            ...(ensured.case_matter_metadata ?? {}),
            source: "mike",
            mike_project_id: ensured.id,
            mike_owner_user_id: ensured.user_id,
        },
    });
    await params.db
        .from("projects")
        .update({
            ...matterCacheFields(matter, ensured.case_primary_vault_id),
            updated_at: new Date().toISOString(),
        })
        .eq("id", ensured.id);
    return matter;
}

export async function archiveCaseMatterForProject(params: {
    db: Db;
    project: ProjectCache;
}): Promise<void> {
    if (!params.project.case_matter_id) return;
    const effective = await getEffectiveCaseApiKey(params.project.user_id, params.db);
    if (!effective) return;
    const client = caseClientForEffectiveKey(effective, {
        userId: params.project.user_id,
        db: params.db,
        service: "matters",
        operation: "matters.archive",
    });
    await client.updateMatter(params.project.case_matter_id, {
        status: "archived",
        archived_at: new Date().toISOString(),
    });
}

export async function caseMatterClientForProject(params: {
    db: Db;
    projectId: string;
}): Promise<{
    client: CaseClient;
    project: ProjectCache;
    matterId: string;
}> {
    const { data: project } = await params.db
        .from("projects")
        .select("*")
        .eq("id", params.projectId)
        .maybeSingle();
    if (!project) throw new Error("Matter not found.");
    const ensured = await ensureCaseMatterForProject({
        db: params.db,
        project: project as ProjectCache,
    });
    if (!ensured.case_matter_id) {
        throw new Error("Matter is not linked to Case.dev.");
    }
    const effective = await getEffectiveCaseApiKey(ensured.user_id, params.db);
    if (!effective) {
        throw new Error("Matter owner has not configured a Case.dev API key.");
    }
    return {
        client: caseClientForEffectiveKey(effective, {
            userId: ensured.user_id,
            db: params.db,
            service: "matters",
            operation: "matters.project_client",
        }),
        project: ensured,
        matterId: ensured.case_matter_id,
    };
}

export function normalizeMatterWorkItems(
    response:
        | { work_items?: CaseMatterWorkItem[]; items?: CaseMatterWorkItem[]; data?: CaseMatterWorkItem[] }
        | CaseMatterWorkItem[],
): CaseMatterWorkItem[] {
    if (Array.isArray(response)) return response;
    return response.work_items ?? response.items ?? response.data ?? [];
}

export function normalizeMatterLogEntries(
    response:
        | { entries?: CaseMatterLogEntry[]; logs?: CaseMatterLogEntry[]; data?: CaseMatterLogEntry[] }
        | CaseMatterLogEntry[],
): CaseMatterLogEntry[] {
    if (Array.isArray(response)) return response;
    return response.entries ?? response.logs ?? response.data ?? [];
}
