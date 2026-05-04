import type { createServerDb } from "./db";
import {
    type CaseSkillDetail,
    type CaseSkillSummary,
} from "./caseClient";
import { caseClientForEffectiveKey, getEffectiveCaseApiKey } from "./caseCredentials";

export type WorkflowSkillFields = {
    case_skill_slug?: string | null;
    case_skill_name?: string | null;
    case_skill_summary?: string | null;
    case_skill_tags?: string[] | unknown;
    case_skill_source?: string | null;
    case_skill_version?: string | number | null;
    case_skill_content_snapshot?: string | null;
    case_skill_synced_at?: string | null;
};

export function normalizeSkillTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((tag): tag is string => typeof tag === "string");
}

export function skillFieldsFromDetail(skill: CaseSkillDetail) {
    return {
        case_skill_slug: skill.slug,
        case_skill_name: skill.name,
        case_skill_summary: skill.summary ?? null,
        case_skill_tags: normalizeSkillTags(skill.tags),
        case_skill_source: skill.source ?? null,
        case_skill_version:
            skill.version === undefined || skill.version === null
                ? null
                : String(skill.version),
        case_skill_content_snapshot: skill.content,
        case_skill_synced_at: new Date().toISOString(),
    };
}

export function composeWorkflowPrompt(workflow: WorkflowSkillFields & {
    title?: string | null;
    prompt_md?: string | null;
}) {
    const skillContent = workflow.case_skill_content_snapshot?.trim();
    const overlay = workflow.prompt_md?.trim();
    if (!skillContent) return overlay ?? "";

    const title = workflow.case_skill_name ?? workflow.title ?? "Case.dev Skill";
    const parts = [
        `# Case.dev Skill: ${title}`,
        workflow.case_skill_summary
            ? `Summary: ${workflow.case_skill_summary}`
            : null,
        workflow.case_skill_tags && normalizeSkillTags(workflow.case_skill_tags).length
            ? `Tags: ${normalizeSkillTags(workflow.case_skill_tags).join(", ")}`
            : null,
        "",
        skillContent,
    ].filter((part) => part !== null);

    if (overlay) {
        parts.push(
            "",
            "# Mike Workflow Overlay",
            "Apply these Mike-specific additions after the Case.dev skill instructions.",
            "",
            overlay,
        );
    }

    return parts.join("\n");
}

export async function getCaseSkillsClient(
    userId: string,
    db: ReturnType<typeof createServerDb>,
) {
    const effective = await getEffectiveCaseApiKey(userId, db);
    if (!effective) {
        throw new Error("Add a Case.dev API key with Skills access in Account > Models.");
    }
    return {
        client: caseClientForEffectiveKey(effective, {
            userId,
            db,
            service: "skills",
            operation: "skills.catalog",
        }),
        keySource: effective.source,
    };
}

export function summarizeSkill(skill: CaseSkillSummary) {
    return {
        slug: skill.slug,
        name: skill.name,
        summary: skill.summary ?? null,
        tags: normalizeSkillTags(skill.tags),
        score: typeof skill.score === "number" ? skill.score : null,
        source: skill.source ?? null,
        version:
            skill.version === undefined || skill.version === null
                ? null
                : String(skill.version),
        author_name: skill.author_name ?? null,
        license: skill.license ?? null,
    };
}

export function serializeSkill(skill: CaseSkillDetail) {
    return {
        ...summarizeSkill(skill),
        content: skill.content,
        metadata: skill.metadata ?? null,
        bundle: skill.bundle ?? null,
    };
}
