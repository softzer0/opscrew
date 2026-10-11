import { db } from "../../../lib/db";

export async function GET() {
  await db.$queryRaw`SELECT 1`;
  return Response.json({ ok: true });
}
