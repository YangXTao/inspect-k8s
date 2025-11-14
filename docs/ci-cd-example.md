# CI/CD 流水线示例

以下示例基于 GitHub Actions，可根据需要调整为 GitLab CI/Jenkins 等平台。流水线包含：数据库迁移、Server/Agent 镜像构建并推送、Helm 发布三个阶段。

```yaml
name: delivery

on:
  push:
    branches: [ main, release/* ]

env:
  REGISTRY: registry.example.com/inspection
  IMAGE_TAG: ${{ github.sha }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - name: Install backend deps
        working-directory: backend
        run: |
          pip install -r requirements.txt
      - name: Run backend tests
        working-directory: backend
        run: pytest
      - uses: actions/setup-node@v4
        with:
          node-version: "18"
      - name: Install frontend deps
        working-directory: frontend
        run: npm ci
      - name: Run frontend lint + unit
        working-directory: frontend
        run: |
          npm run lint
          npm run test -- --runInBand

  build-and-push:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - name: Login registry
        run: echo "${{ secrets.REGISTRY_TOKEN }}" | docker login ${{ env.REGISTRY }} -u ${{ secrets.REGISTRY_USER }} --password-stdin
      - name: Build backend image
        run: |
          docker build -t $REGISTRY/server:$IMAGE_TAG -f backend/Dockerfile .
          docker push $REGISTRY/server:$IMAGE_TAG
      - name: Build agent image
        run: |
          docker build -t $REGISTRY/agent:$IMAGE_TAG -f agent/Dockerfile .
          docker push $REGISTRY/agent:$IMAGE_TAG

  migrate:
    runs-on: ubuntu-latest
    needs: build-and-push
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - name: Install backend deps
        working-directory: backend
        run: pip install -r requirements.txt
      - name: Run Alembic upgrade
        working-directory: backend
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: alembic upgrade head

  deploy:
    runs-on: ubuntu-latest
    needs: migrate
    steps:
      - uses: actions/checkout@v4
      - name: Setup Helm
        uses: azure/setup-helm@v4
      - name: Helm upgrade
        working-directory: charts
        env:
          IMAGE_TAG: ${{ env.IMAGE_TAG }}
        run: |
          helm upgrade --install inspection ./inspection \
            --namespace inspect \
            --create-namespace \
            --set backend.image.repository=${{ env.REGISTRY }}/server \
            --set backend.image.tag=${IMAGE_TAG} \
            --set agent.image.repository=${{ env.REGISTRY }}/agent \
            --set agent.image.tag=${IMAGE_TAG} \
            --set global.migration.enabled=false
```

> 生产环境建议在 `deploy` 前增加人工确认（`environment: production`+`wait_timer`），并将 `global.migration.enabled` 设为 `true` 仅用于一次性 Job，以防多副本重复执行迁移。

## 关键说明

- **分离迁移阶段**：确保数据库迁移与应用部署解耦，失败时不影响旧版本服务。
- **镜像标签**：使用 Git 提交哈希可快速定位回滚版本；也可结合 Release Tag。
- **Agent/Server 同步**：升级 Server 后，应立即滚动升级 Agent 以保持协议兼容。
- **Helm values**：若需要切换执行模式或默认 Agent，可在部署后通过 API/前端界面操作，无需在 Helm 中直接修改。
