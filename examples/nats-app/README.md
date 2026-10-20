# Express + NATS JetStream (OpsCrew example)

An Express API on NATS (`NATS_URL`): jobs go to a JetStream work queue that the Procfile's
`worker` takes them from, and a key-value bucket keeps values. `PUT /data` and `GET /data` write
and read a value, `POST /jobs/<id>` queues a job and `GET /jobs/<id>` answers 200 once it ran.
