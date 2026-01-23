ARG PYTHON_BASE_IMAGE=192.168.10.51/base/zs-inspect-base-image:v0.2
FROM ${PYTHON_BASE_IMAGE} AS runtime


ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    INSPECT_AGENT_CONFIG=/app/config.yaml \
    PYTHONPATH=/app

WORKDIR /app

# 若需替换 PyPI 源，可在构建时传入 PIP_EXTRA_INDEX_URL
ARG PIP_EXTRA_INDEX_URL=""
ENV PIP_EXTRA_INDEX_URL=${PIP_EXTRA_INDEX_URL}

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app/agent

RUN mkdir -p /app/config /app/secret

WORKDIR /app/agent

ENTRYPOINT ["python", "-m", "agent"]
