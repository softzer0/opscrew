# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS base
WORKDIR /app
USER node

FROM base AS build
RUN --mount=type=secret,id=npm_token npm ci

FROM base
COPY --from=build /app /app
ENV NODE_ENV=production \
    SESSION_SECRET_FILE=/run/secrets/session \
    API_TOKEN=${API_TOKEN}
CMD ["node", "server.js"]
