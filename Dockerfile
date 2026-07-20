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

# --- Etapa 2: servir los estáticos con nginx ---
FROM nginx:alpine AS runtime

# Config de nginx (sirve estáticos en el puerto 80)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copiar el build generado en la etapa anterior
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
