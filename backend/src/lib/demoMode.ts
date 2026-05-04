const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);

export type DemoEstimateConfig = {
  llmReserveMicros: number;
  llmUnknownMicros: number;
  vaultUploadBaseMicros: number;
  vaultUploadPerMbMicros: number;
  legalCallMicros: number;
  skillsCallMicros: number;
  mattersCallMicros: number;
  vaultCallMicros: number;
  otherCallMicros: number;
};

export function usdToMicros(value: string | number | undefined, fallbackUsd: number): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : fallbackUsd;
  const safe = Number.isFinite(numeric) && numeric >= 0 ? numeric : fallbackUsd;
  return Math.round(safe * 1_000_000);
}

export function microsToUsd(micros: number): number {
  return Math.round(micros) / 1_000_000;
}

export function isDemoModeEnabled(): boolean {
  const flag = process.env.MIKE_DEMO_MODE?.trim().toLowerCase();
  return TRUE_VALUES.has(flag ?? "") && !!demoCaseApiKey();
}

export function demoCaseApiKey(): string | null {
  return process.env.MIKE_DEMO_CASE_API_KEY?.trim() || null;
}

export function demoBudgetLimitMicros(): number {
  return usdToMicros(process.env.MIKE_DEMO_BUDGET_USD, 5);
}

export function demoGlobalBudgetLimitMicros(): number | null {
  const value = process.env.MIKE_DEMO_GLOBAL_BUDGET_USD?.trim();
  if (!value) return null;
  return usdToMicros(value, 0);
}

export function demoEstimateConfig(): DemoEstimateConfig {
  return {
    llmReserveMicros: usdToMicros(process.env.MIKE_DEMO_LLM_RESERVE_USD, 0.10),
    llmUnknownMicros: usdToMicros(process.env.MIKE_DEMO_LLM_UNKNOWN_USD, 0),
    vaultUploadBaseMicros: usdToMicros(
      process.env.MIKE_DEMO_VAULT_UPLOAD_BASE_USD,
      0,
    ),
    vaultUploadPerMbMicros: usdToMicros(
      process.env.MIKE_DEMO_VAULT_UPLOAD_PER_MB_USD,
      0,
    ),
    legalCallMicros: usdToMicros(process.env.MIKE_DEMO_LEGAL_CALL_USD, 0),
    skillsCallMicros: usdToMicros(process.env.MIKE_DEMO_SKILLS_CALL_USD, 0),
    mattersCallMicros: usdToMicros(process.env.MIKE_DEMO_MATTERS_CALL_USD, 0),
    vaultCallMicros: usdToMicros(process.env.MIKE_DEMO_VAULT_CALL_USD, 0),
    otherCallMicros: usdToMicros(process.env.MIKE_DEMO_OTHER_CALL_USD, 0),
  };
}

export function estimateVaultUploadMicros(sizeBytes?: number | null): number {
  const config = demoEstimateConfig();
  const mb = Math.max(0, sizeBytes ?? 0) / (1024 * 1024);
  return config.vaultUploadBaseMicros + Math.ceil(config.vaultUploadPerMbMicros * mb);
}
