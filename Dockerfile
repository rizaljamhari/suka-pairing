# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Run stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# The server requires no external node_modules since it only uses native Node.js API built-ins
COPY --from=builder /app/client-dist ./client-dist
COPY --from=builder /app/server.mjs ./server.mjs

EXPOSE 8787
CMD ["node", "server.mjs"]
