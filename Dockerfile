# --- Build Stage ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# --- Session Stage ---
FROM node:20-alpine
WORKDIR /app

# Install dependencies needed for better-sqlite3 (native build) + skopeo for image port detection
RUN apk add --no-cache python3 make g++ skopeo

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

# Create data directory for SQLite
RUN mkdir -p /app/data && chown node:node /app/data

EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
