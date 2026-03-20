# UI 静态文件镜像
# 使用前须先在本地执行 pnpm --filter @coclaw/ui build
FROM busybox:stable
LABEL org.opencontainers.image.source="https://github.com/coclaw/coclaw"
LABEL org.opencontainers.image.description="CoClaw UI"
LABEL org.opencontainers.image.licenses="SEE LICENSE IN LICENSE"
WORKDIR /dist
COPY ui/dist/ .
