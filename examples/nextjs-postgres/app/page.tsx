import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home() {
  let now = "database not reachable";
  try {
    const result = await db().query<{ now: Date }>("select now() as now");
    now = result.rows[0]?.now.toISOString() ?? now;
  } catch {
    // The page still renders when the database is down.
  }
  return (
    <main>
      <h1>Hello from Next.js + Postgres</h1>
      <p>Database time: {now}</p>
    </main>
  );
}
