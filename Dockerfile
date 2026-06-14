# mantle-push — small Node service. Runs TS directly via Node's native type
# stripping (Node >= 22.6), so there's no build step.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install deps first for layer caching.
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

COPY . .

EXPOSE 8787
# Strip TS types at runtime (no emit). Override the command in compose to run
# migrations first.
CMD ["node", "src/index.ts"]
