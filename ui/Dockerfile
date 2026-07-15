# UI 静态文件镜像
# 使用前须先在本地执行 pnpm --filter @coclaw/ui build
FROM busybox:stable
# OCI labels：写入单架构 image config，供 docker inspect 等读取
# 多架构构建时 GHCR 需要 manifest index 级 annotations 才能自动关联仓库，
# 由 build-ui.sh 的 --annotation 参数补充，两处需保持一致
LABEL org.opencontainers.image.source="https://github.com/coclaw/coclaw"
LABEL org.opencontainers.image.description="CoClaw UI"
# 不设 org.opencontainers.image.licenses label：镜像只 COPY 编译产物 dist、
# 未打包 LICENSE 文件，原 "SEE LICENSE IN LICENSE" 指向镜像内不存在的文件；
# 许可信息见仓库根 LICENSE 与 THIRD-PARTY-NOTICES.md（经 image.source 可达）
WORKDIR /dist
COPY ui/dist/ .
