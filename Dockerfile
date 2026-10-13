FROM oven/bun:1.4.0
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV NODE_ENV=production HOST=:: PORT=8080
USER bun
EXPOSE 8080
CMD ["bun", "src/server.mjs"]
