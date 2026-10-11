# habit-tracker (OpsCrew example: Lovable export)

A small Vite + React + Supabase app shaped like a Lovable export. It contains planted security
problems that `opscrew scan` must find. Secret-shaped values are written as `{{FAKE:…}}` markers and
expanded into obviously fake values by the tests (`materializeFixture()`), so nothing secret-shaped
is committed.

**URL**: https://lovable.dev/projects/00000000-0000-0000-0000-000000000000
