const cors = require("cors");

// Public, read-only API: any origin, no cookies.
// cors({ origin: "*", credentials: true }) would be dangerous.
module.exports = cors({ origin: "*" });
