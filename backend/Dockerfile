FROM golang:1.25-alpine AS builder
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
# Fail the build if a downloaded module doesn't match go.sum.
RUN go mod download && go mod verify
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/pulsenode ./cmd/pulsenode

FROM alpine:3.22
ARG TARGETARCH
# Bump together: version + per-arch SHA-256 of the release tarball.
ARG NIXPACKS_VERSION=1.41.0
ARG NIXPACKS_SHA256_AMD64=0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6
ARG NIXPACKS_SHA256_ARM64=912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39
RUN apk add --no-cache ca-certificates git docker-cli docker-cli-buildx docker-cli-compose curl \
    && mkdir -p /data /var/lib/pulsenode \
    && case "${TARGETARCH:-amd64}" in \
         amd64) NP_ARCH=x86_64;  NP_SHA="$NIXPACKS_SHA256_AMD64" ;; \
         arm64) NP_ARCH=aarch64; NP_SHA="$NIXPACKS_SHA256_ARM64" ;; \
         *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/nixpacks.tgz \
       "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/nixpacks-v${NIXPACKS_VERSION}-${NP_ARCH}-unknown-linux-musl.tar.gz" \
    && echo "${NP_SHA}  /tmp/nixpacks.tgz" | sha256sum -c - \
    && tar -xzf /tmp/nixpacks.tgz -C /usr/local/bin nixpacks \
    && rm /tmp/nixpacks.tgz \
    && chmod +x /usr/local/bin/nixpacks
WORKDIR /app
ENV GO_PORT=4002
ENV PULSENODE_DATA_DIR=/var/lib/pulsenode
ENV DATABASE_PATH=/data/pulsenode.db
COPY --from=builder /out/pulsenode /usr/local/bin/pulsenode
EXPOSE 4002
CMD ["pulsenode"]
