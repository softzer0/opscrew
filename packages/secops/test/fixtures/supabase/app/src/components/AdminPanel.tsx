import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ?? "";

export function AdminPanel() {
  const client = createClient(url, key);
  return client ? null : null;
}
