import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import express from "express";

// The keys and region come from AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION.
// Path-style addressing and checksums only where required work with every S3-compatible store.
const s3 = new S3Client({
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});
const Bucket = process.env.S3_BUCKET;

const app = express();
const port = process.env.PORT || 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Uploads through a presigned URL, as a browser would.
app.put("/data", express.text(), async (req, res) => {
  const command = new PutObjectCommand({ Bucket, Key: "data" });
  const url = await getSignedUrl(s3, command, { expiresIn: 60 });
  const upload = await fetch(url, { method: "PUT", body: req.body });
  res.sendStatus(upload.ok ? 204 : 502);
});

app.get("/data", async (_req, res) => {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket, Key: "data" }));
    res.send(await object.Body.transformToString());
  } catch (error) {
    res.sendStatus(error.name === "NoSuchKey" ? 404 : 502);
  }
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
