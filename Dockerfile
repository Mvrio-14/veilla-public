# Veilla backend — one image, two Render services. The web service runs the
# CMD below (uvicorn); the worker overrides it with `python -m src.runner`.
# See render.yaml.
FROM python:3.12-slim

# Install system deps only when needed (psycopg2-binary doesn't need them).
WORKDIR /app

# Python buffers stdout in ~8KB blocks whenever it is not a terminal, and in
# a container it never is. The API is unaffected because uvicorn logs through
# the logging module to stderr, but the worker prints — and it is an infinite
# loop, so the buffer is never flushed by the process exiting. The result is a
# worker that runs perfectly and shows no logs at all, which is the worst way
# to be blind during an incident.
ENV PYTHONUNBUFFERED=1

# Copy requirements first so this layer is cached as long as deps don't change.
# requirements.txt is the single source of truth for prod.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code + config (migrations are applied via Supabase, no need here).
COPY src/         ./src/
COPY config/      ./config/
# MCP server exposes tools over stdio (Claude Desktop, local) AND over
# HTTP mounted on the API (remote clients — see src/api.py
# `/mcp` mount). Both paths import the same `mcp_server` package, so
# it has to be inside the container image.
COPY mcp_server/  ./mcp_server/

# Render injects the listening port via $PORT (default 10000).
EXPOSE 10000

# Use sh -c so $PORT gets expanded at container start.
CMD ["sh", "-c", "uvicorn src.api:app --host 0.0.0.0 --port ${PORT:-10000}"]
