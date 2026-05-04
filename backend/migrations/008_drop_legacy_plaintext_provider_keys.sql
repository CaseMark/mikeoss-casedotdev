-- Remove legacy plaintext provider key columns. Case.dev credentials are stored
-- in encrypted case_api_credentials rows, and provider-specific keys are no
-- longer user-configurable in this fork.

alter table if exists public.user_profiles
  drop column if exists claude_api_key,
  drop column if exists gemini_api_key;
