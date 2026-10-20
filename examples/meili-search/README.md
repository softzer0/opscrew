# Express + Meilisearch (OpsCrew example)

An Express API that indexes notes in Meilisearch (`MEILISEARCH_HOST`, `MEILISEARCH_KEY`):
`PUT /data` indexes a value and waits until it is searchable, and `GET /data` finds it again.
