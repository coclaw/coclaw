# ── 阶段 1: 安装依赖 ──
FROM node:22-slim AS deps
WORKDIR /app
# node:22-slim 默认不含 openssl 系统库；prisma 的平台检测据此下载对应 engine，
# 缺失时会回退到 debian-openssl-1.1.x，与最终 runner 阶段的 openssl 3 不匹配。
RUN echo "deb http://mirrors.ustc.edu.cn/debian/ bookworm main contrib non-free non-free-firmware" > /etc/apt/sources.list \
	&& apt-get update && apt-get install -y --no-install-recommends openssl \
	&& rm -rf /var/lib/apt/lists/*
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
# OCI labels：写入单架构 image config，供 docker inspect 等读取
# 多架构构建时 GHCR 需要 manifest index 级 annotations 才能自动关联仓库，
# 由 build-server.sh 的 --annotation 参数补充，两处需保持一致
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
