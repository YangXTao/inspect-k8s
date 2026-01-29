FROM 192.168.10.51/base/zs-inspect-base-image:v0.2
WORKDIR /app


# install fonts for PDF rendering
RUN if command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/*; \
    elif command -v dnf >/dev/null 2>&1; then \
      dnf install -y google-noto-sans-cjk-fonts && dnf clean all; \
    elif command -v yum >/dev/null 2>&1; then \
      yum install -y google-noto-sans-cjk-fonts && yum clean all; \
    elif command -v apk >/dev/null 2>&1; then \
      apk add --no-cache font-noto-cjk; \
    else \
      echo "No known package manager; skip font install."; \
    fi


# 瀹夎渚濊禆
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 鎷疯礉婧愮爜
# copy bundled fonts (optional)
COPY backend/fonts/ /opt/inspect-fonts/

COPY . /app
COPY backend/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
