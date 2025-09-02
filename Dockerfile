# Match package.json -> playwright 1.55.x and includes browsers
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# install deps (no lockfile needed)
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Chrome flags: no sandbox / shm workaround help on small containers
ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_CHROMIUM_ARGS="--no-sandbox --disable-dev-shm-usage --single-process"

CMD ["node", "server.mjs"]
