const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.send(`Hello from ${process.env.REPL_SLUG}`));

app.listen(port, () => console.log(`listening on ${port}`));
