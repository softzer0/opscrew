// A Node backend (no frontend framework): the key is not client code, but hard-coding it is
// still a leaked secret (`supabase/secret-key-in-source`).
const key = "{{FAKE:supabase-service-role-jwt:backend}}";
module.exports = { key };
