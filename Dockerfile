# syntax=docker/dockerfile:1

# --- Etapa 1: build de la app Vite ---
FROM node:22-alpine AS build
WORKDIR /app

# Instalar dependencias (se cachea si package*.json no cambia)
COPY package*.json ./
RUN npm ci

# Copiar el resto del código y generar el build de producción
COPY . .
RUN npm run build

# --- Etapa 2: servidor Node (estáticos + WebSocket colaborativo) ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# Solo dependencias de producción (express, socket.io)
COPY package*.json ./
RUN npm ci --omit=dev

# Servidor y build generado en la etapa anterior
COPY server.js ./
COPY --from=build /app/dist ./dist

# Carpeta persistente para las notas (montar un volumen aquí en Dokploy)
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server.js"]
