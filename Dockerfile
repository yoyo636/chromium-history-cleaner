# Fly.io 部署用 Dockerfile（后端是纯 Python 标准库，零依赖）
FROM python:3.12-slim

WORKDIR /app

# 复制整个仓库（build_all.py 需要仓库根的源文件来打包安装包）
COPY . .

# 构建时生成安装包到 website/dist-packages/（--web 模式）
# server.py 启动时自动探测该目录
RUN python3 build_all.py --web

# Fly.io 注入 PORT 环境变量；server.py 绑定 0.0.0.0:PORT
EXPOSE 8765
CMD ["python3", "website/server.py"]