import express from "express";
import { Meilisearch } from "meilisearch";

const search = new Meilisearch({
  host: process.env.MEILISEARCH_HOST ?? "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_KEY,
});
const notes = search.index("notes");

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Indexes the value as the note `data` and waits until it is searchable.
app.put("/data", express.text(), async (req, res) => {
  await notes.addDocuments([{ id: "data", text: req.body }]).waitTask();
  res.sendStatus(204);
});

app.get("/data", async (_req, res) => {
  try {
    const { hits } = await notes.search("", { limit: 1 });
    if (hits.length === 0) res.sendStatus(404);
    else res.send(hits[0].text);
  } catch (error) {
    if (error.cause?.code !== "index_not_found") throw error;
    res.sendStatus(404);
  }
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
