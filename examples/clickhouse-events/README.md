# Express + ClickHouse events (OpsCrew example)

An Express API that records events in ClickHouse (`CLICKHOUSE_URL`, through `@clickhouse/client`):
`PUT /data` inserts an event, and `GET /data` reads the latest one.
