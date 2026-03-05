FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY server.js ./

# Directorios de datos persistidos via volumen
RUN mkdir -p conversations images

EXPOSE 54321

ENV NODE_ENV=production

CMD ["node", "server.js"]
