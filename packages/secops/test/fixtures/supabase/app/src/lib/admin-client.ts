import { createClient } from "@supabase/supabase-js";

export const admin = createClient(
  "https://fakeprojectref00.supabase.co",
  "{{FAKE:supabase-service-role-jwt}}",
);
