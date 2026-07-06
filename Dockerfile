# Multi-stage build for optimal image size and runtime
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Copy the rest of the project (not node_modules)
COPY . .

# Runtime stage
FROM node:22-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/web ./web

# Ship runtime config + treasury key so the container works without
# hand-set platform secrets (Fly secrets still override .env values)
COPY --from=builder /app/.env ./.env
COPY --from=builder /app/facilitator.pem ./facilitator.pem

# Create data directory for ledger
RUN mkdir -p data

# Expose all three service ports
EXPOSE 4021 4022 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the facilitator, wait until it answers, then start the proxy —
# the proxy's x402 init dies if the facilitator isn't up yet
CMD ["sh", "-c", "npm run facilitator > /tmp/facilitator.log 2>&1 & i=0; until wget -qO- http://127.0.0.1:4022/supported >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 60 ] && echo 'facilitator never came up' && cat /tmp/facilitator.log && exit 1; sleep 1; done; npm run proxy"]