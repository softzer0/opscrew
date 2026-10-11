import { Button } from "@acme/ui";

export default function Page() {
  return <Button label={process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""} />;
}
