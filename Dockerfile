FROM node:22-alpine
WORKDIR /app
COPY package.json proxy.mjs alerts.mjs decision.mjs index.html admin.css admin.js ./
# Key 池落在 /app/data：可挂卷持久化（见 docker-compose.yml），
# 不挂卷时重建容器会丢 Key（告警配置与状态也在这个卷里）。
RUN mkdir -p /app/data
ENV CC_KEYS_FILE=/app/data/keys.json
# Node 22 默认 happy-eyeballs，单地址尝试预算只有 250ms；国内连 Cloudflare 握手常 >250ms，
# 会被 Node 自己判死（fetch failed / ETIMEDOUT）。关掉自动选族 + 强制 IPv4 优先。
ENV NODE_OPTIONS="--no-network-family-autoselection --dns-result-order=ipv4first"
EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --spider http://127.0.0.1:3050/health || exit 1
CMD ["node", "proxy.mjs"]
