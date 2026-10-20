# Object storage

When your app stores files through an S3 client (uploads, images, exports), OpsCrew gives it a
private bucket of its own, on the provider that is cheapest for the use it expects, and shows the
other options with their monthly prices. The bucket is created through OpenTofu or Terraform after
you approve its plan, like the rest of your infrastructure. The key the app uses is one you create
yourself: OpsCrew never creates storage keys.

## The options

| Option | Offered when | Price basis |
|---|---|---|
| **Cloudflare R2** | your domain is on Cloudflare | per GB stored and per million requests, no charge for downloads |
| **DigitalOcean Spaces** | the app runs on DigitalOcean | a monthly base per account, with storage and downloads included |
| **Hetzner Object Storage** | the app runs on Hetzner Cloud in Falkenstein (fsn1), Nuremberg (nbg1) or Helsinki (hel1) | a monthly base per account, with storage and downloads included |
| **Garage** | the app runs on a server you already have, or in your Portainer | free: it keeps the files on the server's own disk |

Garage is a small S3-compatible storage server (AGPL 3.0) that OpsCrew runs as one of the app's
components, without replication: the files are as safe as the server's disk and your backups of
it.

## What it costs

OpsCrew estimates each option for the use your app expects, from the interview's number of users:

| Users a month | Stored | Sent a month |
|---|---|---|
| under 1,000 | 10 GB | 50 GB |
| 1,000 to 10,000 | 50 GB | 250 GB |
| 10,000 to 100,000 | 250 GB | 1,000 GB |
| over 100,000 | 1,000 GB | 5,000 GB |

You can change these figures in `opscrew/plan.yaml` (`storage.objectStorage.expected`), and
`npx opscrew design` prices the options again. No provider publishes these prices through an API
OpsCrew reads, so OpsCrew keeps each provider's published prices with their source; they were
checked on 2026-10-19. Prices exclude VAT and sales tax.

- **Cloudflare R2** ([pricing](https://developers.cloudflare.com/r2/pricing/)), in USD: storage
  costs 0.015 per GB-month after the first 10 GB; write requests (Class A) cost 4.50 per million
  after the first million, and read requests (Class B) 0.36 per million after the first 10 million;
  downloads are free. Cloudflare bills each started GB and million. OpsCrew counts, for objects of
  about 1 MB, every stored object written once a month and one read per MB sent:

  `0.015 × ⌈stored GB − 10⌉ + 4.50 × ⌈(stored GB × 1,000 − 1,000,000) / 1,000,000⌉ + 0.36 × ⌈(sent GB × 1,000 − 10,000,000) / 1,000,000⌉`

  with each part at least 0.
- **DigitalOcean Spaces** ([pricing](https://docs.digitalocean.com/products/spaces/details/pricing/)),
  in USD: 5 a month with 250 GiB stored and 1,024 GiB sent included, then 0.02 per GiB stored and
  0.01 per GiB sent:

  `5 + 0.02 × max(0, stored GiB − 250) + 0.01 × max(0, sent GiB − 1,024)`

  The base is charged once per account, for all its Spaces buckets.
- **Hetzner Object Storage** ([pricing](https://www.hetzner.com/storage/object-storage/), quota
  rules in [Hetzner's documentation](https://docs.hetzner.com/storage/object-storage/overview)), in
  EUR: 6.49 a month, which includes 1 TB stored all month and 1.116 TB sent in a 31-day month
  (less in shorter months), then 6.26 per TB-month stored and 1.00 per TB sent:

  `6.49 + 6.26 × max(0, stored TB − 1) + 1.00 × max(0, sent TB − 1.116)`

  The base is charged once per account, for every hour in which any bucket exists, even an empty
  one. Uploads, traffic inside Hetzner's network zone and the requests themselves are free;
  objects under 64 kB are billed as 64 kB.
- **Garage:** nothing beyond the server.

For the four expected uses above, that gives:

| Stored / sent a month | Cloudflare R2 | DigitalOcean Spaces | Hetzner Object Storage |
|---|---|---|---|
| 10 GB / 50 GB | USD 0.00 | USD 5.00 | EUR 6.49 |
| 50 GB / 250 GB | USD 0.60 | USD 5.00 | EUR 6.49 |
| 250 GB / 1,000 GB | USD 3.60 | USD 5.00 | EUR 6.49 |
| 1,000 GB / 5,000 GB | USD 14.85 | USD 54.95 | EUR 10.37 |

When your account already pays the Spaces or Hetzner base for other buckets, this app adds only
what it uses beyond the shared quota. OpsCrew cannot see that, so it shows the full base price and
says that it is per account.

Design picks the cheapest option it offers and names the others. To use another one, set
`storage.objectStorage.provider` in `opscrew/plan.yaml` and run `npx opscrew design` again.

## What OpsCrew creates

- **One private bucket** for the app, named in `storage.objectStorage.bucket`, in its own
  OpenTofu or Terraform root, `opscrew/infra/storage/`, with a plan you approve by its hash like
  the others. When your app uploads files straight from the browser with presigned URLs, the bucket
  also gets a CORS rule that accepts uploads from your app's own domain only.
- **The app's settings:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
  `AWS_ENDPOINT_URL_S3`, and the bucket and endpoint under the variables your app already reads
  (Laravel's `AWS_BUCKET`, `AWS_DEFAULT_REGION` and `AWS_USE_PATH_STYLE_ENDPOINT` included).

Most S3 clients read `AWS_ENDPOINT_URL_S3` on their own. A few older ones do not (the AWS SDK for
JavaScript v2, Go v1 and Java 1.x): pass the endpoint to the client from that variable in your
code. Garage needs path-style requests (`forcePathStyle: true` in the JavaScript SDK).

## The storage key

OpsCrew never creates a storage key, so no key is ever in its infrastructure state, and its own
tokens need no permission to create one. You create the key in the provider's console, and
`npx opscrew provision` asks for it once in your terminal (in scripts, set
`OPSCREW_STORAGE_ACCESS_KEY_ID` and `OPSCREW_STORAGE_SECRET_ACCESS_KEY`). OpsCrew keeps it on your
computer, in `~/.opscrew/projects/<project>/storage_key.json`, readable only by you, never in your
repository, and gives it to the app with the app's other secrets (your repository's encrypted
deploy secrets, or the stack's variables in your Portainer).

**Hetzner Object Storage**, before the bucket is created:

1. Open the [Hetzner Cloud Console](https://console.hetzner.cloud), choose the project the server
   is in, and go to **Security → S3 credentials**.
2. Choose **Generate credentials**, with the description `opscrew-<app>`. A Hetzner key works for
   every bucket of its project, so a key of this app's own can be revoked without touching other
   apps.
3. Copy the access key and the secret key: Hetzner shows the secret key only once.

**DigitalOcean Spaces**, before the bucket is created:

1. Open **Spaces Object Storage → Access Keys** in the
   [DigitalOcean control panel](https://cloud.digitalocean.com/spaces/access_keys) and choose
   **Create Access Key**.
2. Choose **Full Access** (a key limited to buckets cannot create the bucket) and name it
   `opscrew-<app>`.
3. Copy the access key ID and the secret key: DigitalOcean shows the secret key only once.

**Cloudflare R2**, after the bucket is created (the key is limited to it):

1. Open **R2 Object Storage** in the [Cloudflare dashboard](https://dash.cloudflare.com), choose
   **Manage API tokens**, then **Create Account API token**.
2. Name it `opscrew-<app>`, give it the **Object Read & Write** permission, apply it to specific
   buckets only and pick the app's bucket.
3. Create it and copy the **Access Key ID** and the **Secret Access Key** (not the token value):
   Cloudflare shows the secret only once.

For R2, OpsCrew creates the bucket with your Cloudflare token (`CLOUDFLARE_API_TOKEN`), which then
also needs the **Account → Workers R2 Storage → Edit** permission.

**Garage** needs no key from you: OpsCrew generates Garage's key and gives it to the app.

To replace a key, create a new one, delete OpsCrew's copy (`storage_key.json`) or set the two
variables to the new key, run `npx opscrew provision`, re-run the deploy workflow, then revoke the
old key in the provider's console.

## Removing the app

`npx opscrew destroy` keeps the bucket and its files, which the provider bills until the bucket is
deleted. To delete it too, add `--delete-data` (and type the app's name). An R2 bucket must be
empty first: Cloudflare refuses to delete a bucket that holds files, and OpsCrew never deletes your
files itself. Moving the app to another provider with `npx opscrew retarget` leaves the bucket
where it is.
