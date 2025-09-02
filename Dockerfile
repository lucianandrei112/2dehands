# Matcht met package.json (playwright 1.55.0) en bevat browsers
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Eerst dependencies installeren (zonder lockfile kan dit ook)
COPY package.json ./
RUN npm install --omit=dev

# Dan pas de rest kopiëren
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

# Browsers zijn al geïnstalleerd in de base image
CMD ["node", "server.mjs"]
