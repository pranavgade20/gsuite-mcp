# gsuite-mcp: authenticated Streamable HTTP MCP server. Google tokens stay in
# this container; agents only receive the separate MCP access key.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV GSUITE_MCP_TRANSPORT=http \
    GSUITE_MCP_HOST=0.0.0.0 \
    GSUITE_MCP_PORT=8080 \
    GSUITE_MCP_ALLOW_PRIVATE_HTTP=true \
    GSUITE_MCP_BEARER_TOKEN_FILE=/run/secrets/mcp_key \
    GMAIL_MCP_CONFIG_DIR=/credentials
EXPOSE 8080
USER node
CMD ["node", "dist/src/index.js"]
