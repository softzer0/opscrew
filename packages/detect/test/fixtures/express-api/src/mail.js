import nodemailer from "nodemailer";

const { SMTP_HOST, SMTP_PASSWORD: password, ...rest } = process.env;

export const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  auth: { user: "orders", pass: password },
  logger: Boolean(rest.DEBUG_MAIL),
});
