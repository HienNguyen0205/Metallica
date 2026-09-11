# FRIDAY orchestrator — single-process uvicorn, matching render.yaml.
#
# Build from the repo root (this file lives in backend/, not at the root):
#   docker build -f backend/Dockerfile -t friday-orchestrator ./backend
# Run locally (keys come from the environment, never baked into the image):
#   docker run --rm -p 8000:8000 --env-file backend/.env \
#     -e FRIDAY_ALLOWED_ORIGINS=http://localhost:3000 friday-orchestrator
# Health: GET /health (same path render.yaml checks).

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Render assigns $PORT; local runs fall back to 8000.
    PORT=8000

WORKDIR /app

# Dependencies first so rebuilds after a code-only change reuse the layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY friday/ ./friday/

# Deliberately rootless, and deliberately one process: §11 approvals live in
# an in-process dict, so a second worker (or gunicorn -k uvicorn) would answer
# /confirm without the pending Future and time every approval out as denied.
USER nobody
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','8000')}/health\")"

CMD ["sh", "-c", "uvicorn friday.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
