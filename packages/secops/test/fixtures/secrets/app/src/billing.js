const stripe = require("stripe")("{{FAKE:stripe-live-key}}");
const slack = "{{FAKE:slack-bot-token}}";
const maps = { key: "{{FAKE:google-api-key}}" };
module.exports = { stripe, slack, maps };
