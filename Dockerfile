FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN uv sync --locked --no-dev --no-editable && mkdir /data && chown 10001 /data
# The hub sits behind an ingress, so trust its X-Forwarded-Proto: install.sh then advertises the https URL.
ENV DESKMATE_DB=/data/deskmate.db FORWARDED_ALLOW_IPS=*
USER 10001
VOLUME /data
EXPOSE 8787
CMD ["/app/.venv/bin/deskmate", "hub", "--host", "0.0.0.0", "--port", "8787"]
