FROM node:22-alpine
WORKDIR /app
# Chromium powers the MCP get_screenshot / get_computed_styles tools.
RUN apk add --no-cache chromium font-noto
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data \
    CHROME_PATH=/usr/bin/chromium-browser CHROME_FLAGS="--no-sandbox --disable-dev-shm-usage"
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY *.js ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
