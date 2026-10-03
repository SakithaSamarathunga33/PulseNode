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
# Vulnerability scanner (Trivy) + SBOM generator (Syft): pinned, per-arch SHA-256 of the release tarballs.
ARG TRIVY_VERSION=0.75.0
ARG TRIVY_SHA256_AMD64=c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f
ARG TRIVY_SHA256_ARM64=a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3
ARG SYFT_VERSION=1.54.0
ARG SYFT_SHA256_AMD64=54a87372498168b2d033e876fd41fa4e8035b872699e525a57046e1f2f09c860
ARG SYFT_SHA256_ARM64=ee6d4566373a05b344bc6b5f1706f14419bf9338ba39ff686e247deefe9b8818
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
    && chmod +x /usr/local/bin/nixpacks \
    && case "${TARGETARCH:-amd64}" in \
         amd64) TV_ARCH=64bit; TV_SHA="$TRIVY_SHA256_AMD64"; SY_ARCH=amd64; SY_SHA="$SYFT_SHA256_AMD64" ;; \
         arm64) TV_ARCH=ARM64; TV_SHA="$TRIVY_SHA256_ARM64"; SY_ARCH=arm64; SY_SHA="$SYFT_SHA256_ARM64" ;; \
         *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/trivy.tgz \
       "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${TV_ARCH}.tar.gz" \
    && echo "${TV_SHA}  /tmp/trivy.tgz" | sha256sum -c - \
    && tar -xzf /tmp/trivy.tgz -C /usr/local/bin trivy \
    && curl -fsSL -o /tmp/syft.tgz \
       "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_${SY_ARCH}.tar.gz" \
    && echo "${SY_SHA}  /tmp/syft.tgz" | sha256sum -c - \
    && tar -xzf /tmp/syft.tgz -C /usr/local/bin syft \
    && rm /tmp/trivy.tgz /tmp/syft.tgz \
    && chmod +x /usr/local/bin/trivy /usr/local/bin/syft
WORKDIR /app
ENV GO_PORT=4002
ENV PULSENODE_DATA_DIR=/var/lib/pulsenode
ENV DATABASE_PATH=/data/pulsenode.db
# Trivy vulnerability DB: its own volume (pn-trivy-cache in docker-compose.yml), kept apart from the
# data volume that holds aes-key/jwt-secret, so it is not re-downloaded on every restart.
ENV TRIVY_CACHE_DIR=/var/cache/trivy
RUN mkdir -p /var/cache/trivy
ENV SYFT_CHECK_FOR_APP_UPDATE=false
COPY --from=builder /out/pulsenode /usr/local/bin/pulsenode
EXPOSE 4002
CMD ["pulsenode"]
