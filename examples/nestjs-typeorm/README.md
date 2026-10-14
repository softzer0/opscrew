# NestJS + TypeORM (OpsCrew example)

A NestJS API in the `nest new` layout that counts visits in Postgres through TypeORM and `DATABASE_URL`, with the table created by a committed migration run from the compiled data source (`typeorm migration:run -d dist/data-source.js`), and answers `GET /health` without the database.
