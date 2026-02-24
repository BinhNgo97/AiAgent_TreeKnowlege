# ── Cognitive Graph Agent — Dockerfile ─────────────────────────────
FROM python:3.12-slim

# Tránh .pyc files và buffer stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Cài dependencies trước để tận dụng Docker layer cache
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Thư mục data sẽ được mount từ host
RUN mkdir -p /app/data

# Railway inject $PORT dynamically — fallback 8001 cho local Docker
EXPOSE 8001

# Chạy production (không --reload)
# Shell form để $PORT được expand
CMD ["sh", "-c", "uvicorn webapp.main:app --host 0.0.0.0 --port ${PORT:-8001}"]
