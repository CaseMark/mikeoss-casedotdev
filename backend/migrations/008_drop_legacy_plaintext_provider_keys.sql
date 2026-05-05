-- Remove legacy plaintext provider key columns. Case.dev credentials are stored
-- in encrypted case_api_credentials rows, and provider-specific keys now live
-- in encrypted provider_api_credentials rows.

alter table if exists public.user_profiles
  drop column if exists claude_api_key,
  drop column if exists gemini_api_key;
