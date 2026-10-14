import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";
import { visits } from "./db/schema.js";

// node-postgres connects on the first query, so the server starts without the database.
const db = drizzle(process.env.DATABASE_URL);

const app = express();
const port = process.env.PORT || 3000;

app.get("/", async (_req, res) => {
  await db.insert(visits).values({});
  const [{ total }] = await db.select({ total: count() }).from(visits);
  res.json({ visits: total });
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
