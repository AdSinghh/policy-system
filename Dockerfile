# syntax=docker/dockerfile:1
FROM node:20-alpine

# Wall-clock scheduling is resolved through explicit IANA zones, but pinning the
# container to UTC keeps logs and any incidental Date output unambiguous.
ENV TZ=UTC \
    NODE_ENV=production \
    PORT=4000

WORKDIR /app

# tini gives us a real init: it reaps zombies and forwards SIGTERM to the cluster
# primary, which is what makes the graceful drain work under `docker stop`.
RUN apk add --no-cache tini

# Dependencies in their own layer so source edits do not reinstall node_modules.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Uploads are scratch space written at runtime; create it owned by the app user.
RUN mkdir -p /app/uploads && chown -R node:node /app

# Never run as root. Combined with .dockerignore (which keeps .env, uploads/ and
# node_modules out of the image) this is the difference between shipping code and
# shipping your Atlas credentials.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
