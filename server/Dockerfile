FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8787
ENV CRAWL_MODE=server
ENV PLAYWRIGHT_HEADLESS=true

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8787/api/health || exit 1

CMD ["node", "index.js"]
