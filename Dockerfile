# Stated: one image, two commands.
#   default            the connected app (needs DATABASE_URL, STATED_TOKEN_KEY, X_CLIENT_ID; see docs/DEPLOY.md)
#   compose.yaml       the same code against a simulated X, for trying it with no accounts or keys
# Node 26 is the version the test suite runs on. The wallet bundle in server/public is prebuilt,
# so no build step runs here and dev dependencies are left out.
FROM node:26-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/src/main.mjs"]
