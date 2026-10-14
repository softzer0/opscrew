const Router = require("@koa/router");
const Koa = require("koa");
const knex = require("knex");
const config = require("./knexfile");

// Knex connects on the first query, so the server starts without the database.
const db = knex(config);

const app = new Koa();
const router = new Router();
const port = process.env.PORT || 3000;

router.get("/", async (ctx) => {
  await db("visits").insert({});
  const [{ total }] = await db("visits").count({ total: "*" });
  ctx.body = { visits: Number(total) };
});

app.use(router.routes()).use(router.allowedMethods());

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
