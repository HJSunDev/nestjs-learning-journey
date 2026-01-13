# ============================================================
# NestJS Production Dockerfile (Multi-stage Build)
# ============================================================
# 多阶段构建策略：
# 1. builder 阶段：安装全部依赖 + 编译 TypeScript
# 2. production 阶段：仅安装生产依赖 + 复制编译产物
# 
# 优势：生产镜像体积约 150-180MB（对比单阶段 1GB+）

# ============================================================
# Stage 1: Builder - 构建阶段
# ============================================================
FROM node:22-alpine AS builder

# 设置工作目录
WORKDIR /app

# 先复制依赖清单文件（利用 Docker 层缓存）
# 只有 package*.json 变化时才会重新 npm ci
COPY package*.json ./

# 安装全部依赖（包括 devDependencies，用于编译）
# npm ci 比 npm install 更快且确定性安装
RUN npm ci

# 复制源代码
COPY . .

# 编译 TypeScript -> JavaScript
RUN npm run build

# ============================================================
# Stage 2: Production - 生产阶段
# ============================================================
FROM node:22-alpine AS production

# 设置 Node.js 生产环境标识
ENV NODE_ENV=production

# 设置工作目录
WORKDIR /app

# 先复制依赖清单文件
COPY package*.json ./

# 仅安装生产依赖（排除 devDependencies）
# --omit=dev 是 npm 8+ 的标准写法
RUN npm ci --omit=dev

# 从 builder 阶段复制编译产物
COPY --from=builder /app/dist ./dist

# 生产环境需要写入日志与本地上传目录，提前创建并赋权给非 root 用户避免 EACCES
RUN mkdir -p logs static/upload && chown -R node:node /app

# 创建非 root 用户运行应用（安全最佳实践）
# Alpine 镜像自带 node 用户，直接使用即可
USER node

# 暴露应用端口（文档性声明，实际端口由 APP_PORT 环境变量控制）
EXPOSE 3000

# 健康检查配置
# 使用轻量级的 liveness 端点，避免检查外部依赖导致误判
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${APP_PORT:-3000}/health/liveness || exit 1

# 启动命令
# 使用 node 直接运行，确保 SIGTERM 信号正确传递（优雅关闭）
# TypeScript 的输出目录结构包含 src（例如 dist/src/...），与项目的 typeorm 脚本保持一致
CMD ["node", "dist/src/main.js"]
