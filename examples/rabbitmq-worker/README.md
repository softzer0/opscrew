# Express + RabbitMQ worker (OpsCrew example)

An Express API that queues jobs on RabbitMQ (`AMQP_URL`, through `amqplib`); the Procfile's
`worker` runs them and reports each one in the `done` queue. `PUT /data` and `GET /data` keep a
value as a persistent message, `POST /jobs/<id>` queues a job and `GET /jobs/<id>` answers 200
once it ran.
