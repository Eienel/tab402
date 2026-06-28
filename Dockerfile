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

# Build/verify TypeScript
RUN npm run typecheck

# Runtime stage
FROM node:22-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package.json tsconfig.json ./

# Create data directory for ledger
RUN mkdir -p data

# Expose all three service ports
EXPOSE 4021 4022 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Default: start facilitator + proxy in background, then proxy in foreground
# Railway will map ports, and we'll handle service routing via environment
CMD ["sh", "-c", "npm run facilitator > /tmp/facilitator.log 2>&1 & npm run proxy"]
