import express from "express";
import { MongoClient } from "mongodb";

// The driver connects on the first operation, so the server starts without the database. The
// database is the one the URI names.
const client = new MongoClient(process.env.MONGODB_URI ?? "mongodb://localhost:27017/app");
const items = client.db().collection("items");

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.put("/data", express.text(), async (req, res) => {
  await items.updateOne({ _id: "data" }, { $set: { value: req.body } }, { upsert: true });
  res.sendStatus(204);
});

app.get("/data", async (_req, res) => {
  const item = await items.findOne({ _id: "data" });
  if (item === null) res.sendStatus(404);
  else res.send(item.value);
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
