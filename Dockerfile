FROM node:22-slim
WORKDIR /app

# Headless Chromium (chrome-headless-shell) powers MCP get_screenshot / get_computed_styles
# without pulling full desktop Chromium, GTK, GStreamer, or LLVM/Mesa bloat.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libpango-1.0-0 libcairo2 libasound2 fonts-liberation \
    && arch="$(uname -m)" \
    && case "$arch" in \
         x86_64|amd64) plat="linux64" ;; \
         aarch64|arm64) plat="linux-arm64" ;; \
         *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
       esac \
    && url="$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json \
         | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const item=d.channels.Stable.downloads['chrome-headless-shell'].find(x=>x.platform==='$plat'); if(!item) process.exit(1); process.stdout.write(item.url);")" \
    && curl -fsSL "$url" -o /tmp/chs.zip \
    && unzip -q /tmp/chs.zip -d /opt \
    && mv "/opt/chrome-headless-shell-$plat" /opt/chrome-headless-shell \
    && ln -s /opt/chrome-headless-shell/chrome-headless-shell /usr/local/bin/chrome-headless-shell \
    && rm -rf /tmp/chs.zip /var/lib/apt/lists/* \
    && apt-get purge -y --auto-remove curl unzip

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data \
    CHROME_PATH=/usr/local/bin/chrome-headless-shell \
    CHROME_FLAGS="--no-sandbox --disable-dev-shm-usage --disable-gpu"

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY *.js ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
