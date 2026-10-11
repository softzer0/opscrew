FROM node:latest
WORKDIR /app
# Build-time secret passed the safe way: no default value.
ARG NPM_TOKEN
ENV NODE_ENV=production \
    API_SECRET="{{FAKE:generic-password:docker}}"
ARG DB_PASSWORD={{FAKE:generic-password:dockerarg}}
COPY . .
CMD ["node", "server.js"]
