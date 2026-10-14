# Express + Drizzle (OpsCrew example)

A small Express 5 API that counts visits in Postgres through Drizzle ORM and `DATABASE_URL`, with the table created by a committed drizzle-kit migration (`drizzle-kit migrate`); it has no health route, so OpsCrew adds one.
