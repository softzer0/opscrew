FROM ubuntu
ENV DATABASE_URL=postgres://db.internal:5432/app
RUN apt-get update && apt-get install -y python3
USER root
CMD ["python3", "worker.py"]
