FROM node:20-slim

# Playwright deps
RUN apt-get update && apt-get install -y \
    libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 \
    libcairo2 libatspi2.0-0 libwayland-client0 libx11-6 libxext6 \
    fonts-liberation libxfixes3 libxrender1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Install Playwright browsers
RUN npx playwright install --with-deps chromium

COPY . .
ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.mjs"]
