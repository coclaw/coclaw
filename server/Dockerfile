# ── 阶段 1: 安装依赖 ──
FROM node:22-slim AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json server/
RUN corepack enable && pnpm install --frozen-lockfile --filter @coclaw/server

# ── 阶段 2: 构建产物 ──
FROM deps AS build
COPY server/ server/
RUN pnpm --filter @coclaw/server prisma:generate \
	&& pnpm --filter @coclaw/server deploy --legacy --prod /deploy/server

# ── 阶段 3: 运行时 ──
FROM node:22-slim AS runner
LABEL org.opencontainers.image.source="https://github.com/coclaw/coclaw"
LABEL org.opencontainers.image.description="CoClaw server"
LABEL org.opencontainers.image.licenses="SEE LICENSE IN LICENSE"
RUN echo "deb http://mirrors.ustc.edu.cn/debian/ bookworm main contrib non-free non-free-firmware" > /etc/apt/sources.list \
	&& echo "deb http://mirrors.ustc.edu.cn/debian/ bookworm-updates main contrib non-free non-free-firmware" >> /etc/apt/sources.list \
	&& echo "deb http://mirrors.ustc.edu.cn/debian-security/ bookworm-security main contrib non-free non-free-firmware" >> /etc/apt/sources.list \
	&& apt-get update && apt-get install -y --no-install-recommends curl \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /deploy/server .
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
