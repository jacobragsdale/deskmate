# The hub's image: Node and the one built file. Build that first, with `npm ci && npm run build`.
FROM node:26-slim
WORKDIR /app
COPY dist/deskmate.js ./
RUN mkdir /data && chown 10001 /data
ENV DESKMATE_DB=/data/deskmate.db
USER 10001
VOLUME /data
EXPOSE 8787
CMD ["node", "/app/deskmate.js", "hub", "--host", "0.0.0.0", "--port", "8787"]
