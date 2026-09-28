# Aria: no dependencies, so no install step.
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=4180 ARIA_DATA_DIR=/data
RUN mkdir /data && chown node /data
VOLUME /data
EXPOSE 4180
USER node
HEALTHCHECK CMD wget -qO- http://127.0.0.1:4180/api/healthz || exit 1
CMD ["node", "--no-warnings", "server.js"]
