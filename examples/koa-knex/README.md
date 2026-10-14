# Koa + Knex (OpsCrew example)

A small Koa API that counts visits in Postgres through Knex and `DATABASE_URL`, with the table created by a committed Knex migration (`knex migrate:latest`); it has no health route, so OpsCrew adds one.
