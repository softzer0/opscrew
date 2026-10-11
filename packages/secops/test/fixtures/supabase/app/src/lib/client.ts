import { createClient } from "@supabase/supabase-js";

// The anon key is meant to be public.
export const supabase = createClient(
  "https://fakeprojectref00.supabase.co",
  "{{FAKE:supabase-anon-jwt}}",
);
