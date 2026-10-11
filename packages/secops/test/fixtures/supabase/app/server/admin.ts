// Server-only code: not sent to browsers, but a hard-coded service-role key is still a leaked
// secret (`supabase/secret-key-in-source`, high; critical once committed to git).
export const SERVICE_ROLE = "{{FAKE:supabase-service-role-jwt:server}}";
