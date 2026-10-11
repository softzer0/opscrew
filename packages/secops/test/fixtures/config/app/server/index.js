const express = require("express");
const cors = require("cors");

const app = express();
app.use(
  cors({
    origin: "*",
    credentials: true,
  }),
);

module.exports = app;
