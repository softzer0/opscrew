FROM node:20-alpine
WORKDIR /app
COPY . .
RUN yarn install --frozen-lockfile && yarn build
USER node
EXPOSE 3000
CMD ["yarn", "start"]
