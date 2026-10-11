FROM golang:1.23 AS build
WORKDIR /src
RUN go build -o /out/app .

FROM gcr.io/distroless/static-debian12:nonroot@sha256:0000000000000000000000000000000000000000000000000000000000000000
COPY --from=build /out/app /app
ENTRYPOINT ["/app"]
