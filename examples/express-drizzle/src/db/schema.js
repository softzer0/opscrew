import { integer, pgTable, timestamp } from "drizzle-orm/pg-core";

export const visits = pgTable("visits", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
