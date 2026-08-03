FROM node:24-alpine

WORKDIR /app
COPY server.cjs /app/server.cjs

ENV NODE_ENV=production
ENV OMNIA_V5_BRIDGE_HOST=0.0.0.0
ENV OMNIA_V5_BRIDGE_PORT=18785

USER node
EXPOSE 18785
CMD ["node", "/app/server.cjs"]
