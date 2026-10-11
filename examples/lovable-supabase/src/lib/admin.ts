import { createClient } from "@supabase/supabase-js";

// Planted problem for OpsCrew tests: a service-role key shipped in frontend code.
const SERVICE_ROLE_KEY = "{{FAKE:supabase-service-role-jwt}}";

export const adminClient = createClient("https://fakeprojectref00.supabase.co", SERVICE_ROLE_KEY);
