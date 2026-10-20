# Express + Kafka (OpsCrew example)

An Express API on Kafka (`KAFKA_BROKERS`, through KafkaJS): it sends jobs to the `jobs` topic,
the Procfile's `worker` reports each one on `done`, and the latest message on `data` is the
value. `PUT /data` and `GET /data` write and read it, `POST /jobs/<id>` queues a job and
`GET /jobs/<id>` answers 200 once it ran.
