# --- Build Stage ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# --- Production Stage ---
FROM node:20-alpine
WORKDIR /app

# Install skopeo for image port detection
RUN apk add --no-cache skopeo

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
