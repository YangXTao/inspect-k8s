# 自动化测试清单

## 1. 后端单元 & 集成测试

- **覆盖重点**
  - `execution_mode`、`default_agent_id` 字段的 CRUD 逻辑。
  - `/agents` 相关 API（注册、心跳、任务领取、结果上报）的令牌校验、幂等性。
  - Agent 触发的巡检状态迁移（`queued` → `running` → `finished/failed`）。
- **脚本框架示例**
  ```python
  # tests/test_agents.py
  import pytest
  from httpx import AsyncClient

  @pytest.mark.asyncio
  async def test_register_agent(async_client: AsyncClient, db_session):
      payload = {"name": "agent-a", "cluster_id": None}
      resp = await async_client.post("/agents", json=payload)
      assert resp.status_code == 201
      data = resp.json()
      assert "token" in data

  @pytest.mark.asyncio
  async def test_agent_pull_tasks(async_client: AsyncClient, seeded_agent):
      resp = await async_client.get(f"/agents/{seeded_agent.id}/tasks")
      assert resp.status_code == 200
      assert isinstance(resp.json(), list)
  ```
  执行命令：`pytest tests/test_agents.py`

## 2. API 合约测试（Smoke / Contract）

- **覆盖重点**
  - 巡检创建、状态轮询与取消流程。
  - 集群切换执行模式时，保证旧字段兼容（未配置 Agent 时默认回退到 server）。
  - License 限制下返回的错误信息。
- **脚本框架示例**
  ```python
  # tests/test_api_contract.py
  def test_switch_execution_mode(client, cluster_factory, agent_factory):
      cluster = cluster_factory()
      agent = agent_factory()
      response = client.put(
          f"/clusters/{cluster.id}",
          data={"execution_mode": "agent", "default_agent_id": agent.id},
      )
      assert response.status_code == 200
      assert response.json()["execution_mode"] == "agent"
  ```
  执行命令：`pytest tests/test_api_contract.py`

## 3. Agent 客户端集成测试

- **覆盖重点**
  - Agent CLI/Python 客户端对注册、心跳、拉取、上报的串联流程。
  - Token 失效、长时间未心跳自动回收的逻辑。
- **脚本框架示例**
  ```python
  # agent/tests/test_agent_client.py
  from agent.client import AgentClient

  def test_agent_pull_and_report(mock_server):
      client = AgentClient(base_url=mock_server.url, token="abc")
      tasks = client.fetch_tasks()
      assert tasks
      result = client.submit_result(tasks[0]["run_id"], status="finished")
      assert result["status"] == "finished"
  ```
  执行命令：`pytest agent/tests/test_agent_client.py`

## 4. 前端组件 & E2E 测试

- **组件测试重点**
  - 集群详情页的执行模式选择器（禁用态、无 Agent、保存成功提示）。
  - Agent 设置面板（列表渲染、创建流程、Token 提示）。
- **E2E 测试重点**
  - 通过 UI 新建 Agent → 绑定到集群 → 发起巡检 → Agent 回传结果。
  - 切换到 `server` 模式后，确认巡检立即运行。
- **脚本框架示例（Playwright）**
  ```ts
  // tests/e2e/agent-mode.spec.ts
  import { test, expect } from "@playwright/test";

  test("cluster can switch to agent mode", async ({ page }) => {
    await page.goto("/");
    await page.click("text=设置");
    await page.click("text=Agent 管理");
    await page.click("text=创建 Agent");
    // ... 省略表单填写步骤
    await expect(page.getByText("Agent 已启用")).toBeVisible();
  });
  ```
  执行命令：`npx playwright test tests/e2e/agent-mode.spec.ts`

## 5. 冒烟回归场景

- 新建/删除集群，确认 `execution_mode` 默认值仍为 `server`。
- 旧的巡检历史列表在新增列后能够正常展示、筛选、分页。
- Agent 离线超过阈值后，任务被自动回滚到 `queued`。
- 回滚到老版本（无 Agent 特性）时，前端/后端不出现字段缺失错误。

建议以 `make smoke` 或 `pytest -m smoke` 的方式整理最小冒烟集。执行前确保：

```bash
export DATABASE_URL=...
export LICENSE_SECRET=...
pytest -m smoke
```
