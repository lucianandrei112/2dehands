FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .
ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.mjs"]
