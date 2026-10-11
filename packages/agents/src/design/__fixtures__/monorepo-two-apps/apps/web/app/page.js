import { label } from "@acme/ui";

export default function Page() {
  return label(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}
