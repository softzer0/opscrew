FROM node:latest
WORKDIR /app
# A build argument with a secret name: a value passed with --build-arg lands in the image history.
ARG NPM_TOKEN
ENV NODE_ENV=production \
    API_SECRET="{{FAKE:generic-password:docker}}"
ARG DB_PASSWORD={{FAKE:generic-password:dockerarg}}
COPY . .
CMD ["node", "server.js"]
