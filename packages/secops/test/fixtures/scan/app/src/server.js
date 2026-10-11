const express = require("express");

const app = express();
const GITHUB_TOKEN = "{{FAKE:github-token}}";

app.get("/", (_req, res) => res.send("ok"));
app.listen(3000);
module.exports = { app, GITHUB_TOKEN };
