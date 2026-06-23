# ---------- Estágio 1: build ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npx prisma generate && npm run build

# ---------- Estágio 2: runtime ----------
FROM node:20-alpine AS runner

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

# Somente dependências de produção + Prisma Client gerado
RUN npm ci --omit=dev && npx prisma generate

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Usuário sem privilégios
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs
USER nodejs

EXPOSE 3333

# Aplica migrations pendentes e sobe o servidor
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
