# Next.js + Postgres (OpsCrew example)

A minimal real Next.js app (app router) that reads the time from Postgres via `DATABASE_URL`. It has
no Dockerfile, no health endpoint and no standalone output, so `opscrew design` lists those code
changes and `opscrew adapt` adds them. The live end-to-end test deploys this app to Hetzner.
