# Express + S3 presigned uploads (OpsCrew example)

An Express API that stores files in an S3 bucket (`S3_BUCKET`, `AWS_ENDPOINT_URL_S3`): `PUT /data`
uploads through a presigned URL, as a browser would, and `GET /data` reads the object back.
