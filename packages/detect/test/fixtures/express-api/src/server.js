import express from "express";
import { pool } from "./db.js";
import { mailer } from "./mail.js";

const app = express();
const stripeKey = process.env["STRIPE_SECRET_KEY"];

app.get("/healthz", (_req, res) => res.send("ok"));
app.post("/orders", async (_req, res) => {
  await pool.query("select 1");
  res.json({ stripe: Boolean(stripeKey), mailer: Boolean(mailer) });
});

app.listen(process.env.PORT ?? 8080);
