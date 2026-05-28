-- Add provider column to ai_sessions for multi-provider tracking.
-- Safe to run multiple times — uses ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.ai_sessions
  ADD COLUMN IF NOT EXISTS provider TEXT;

COMMENT ON COLUMN public.ai_sessions.provider IS
  'AI provider used: openai, anthropic, gemini, local';
