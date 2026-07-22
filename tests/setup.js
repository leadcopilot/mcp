// Load .env for live integration tests (Supabase, Gemini). Tests that need real
// credentials guard themselves and skip when the vars are absent (e.g. in CI).
import 'dotenv/config';
