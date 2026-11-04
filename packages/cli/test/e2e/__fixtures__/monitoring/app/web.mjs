// The monitoring Docker pass's web service: 200 on every path, a line for each request, and every
// second a line with a value of its app.env (KNOWN_VALUE) and a token (GITHUB_TOKEN), which
// Grafana Alloy must mask before the lines leave the server.
import http from "node:http";

const { KNOWN_VALUE, GITHUB_TOKEN } = process.env;
let tick = 0;
setInterval(() => {
  tick++;
  console.log(`tick ${tick} token=${GITHUB_TOKEN} password=${KNOWN_VALUE}`);
}, 1000);
http
  .createServer((request, response) => {
    console.log(`${request.method} ${request.url} 200`);
    response.end("ok\n");
  })
  .listen(3000);
process.on("SIGTERM", () => process.exit(0));
