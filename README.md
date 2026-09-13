# 展厅灯光提示联排演练器

纯前端演练器：导入一份 UTF-8 JSON 提示清单后，按数组顺序在各自截止时刻执行提示，模拟闭馆后灯光联排。针对“浏览器标签页降频导致定时回调延迟”的场景设计：所有截止时刻都由单调时钟的绝对时刻计算，延迟回调只会造成**集中处理**，不会把整段演练顺延。

技术栈：TypeScript + React + Vite，Vitest 单元测试，Playwright 端到端测试。

## 启动

### Docker Compose（推荐）

```bash
docker compose up --build web
```

打开 <http://localhost:8080>。宿主端口可用环境变量 `WEB_PORT` 覆盖：

```bash
WEB_PORT=3000 docker compose up --build web   # 打开 http://localhost:3000
```

### 一次性验收服务 verify

```bash
docker compose run --build --rm verify
```

`verify` 服务在含浏览器的镜像中依次执行 `npm run build`、Vitest 单元测试和 Playwright 端到端测试（Playwright 会启动 `vite preview` 并驱动真实浏览器覆盖计时链路），跑完即退出。

### 本地开发

```bash
npm install
npm run dev        # 开发服务器
npm run verify     # 构建 + Vitest + Playwright（需先 npx playwright install chromium）
```

## JSON 清单格式

页面通过“导入提示清单”读取 UTF-8 JSON 文件，顶层必须是**非空数组**，每项只能包含以下三个字段：

| 字段         | 要求                                       |
| ------------ | ------------------------------------------ |
| `id`         | 字符串或数字，全清单内唯一，不能为空       |
| `label`      | 非空字符串（去除首尾空白后不能为空）       |
| `durationMs` | 整数，范围 **100 ～ 600000**（该项时长，毫秒） |

示例（见 `examples/cues.sample.json`）：

```json
[
  { "id": "open", "label": "开场主灯渐亮", "durationMs": 3000 },
  { "id": "spot", "label": "追光扫过中央展台", "durationMs": 5000 }
]
```

**任一项非法（含出现额外字段）即整份拒绝**：页面就地显示错误原因，当前已载入的有效数据保持不变。

## 计时语义

- **单调时钟**：截止时刻由 `performance.now()` 计算（引擎通过构造函数注入时钟，测试中以手动时钟精确驱动）。
- **绝对截止，不靠递减 tick**：第 n 项的计划截止时刻 = 启动时刻 + 前 n 项时长累加。回调迟到不会改变后续项的截止时刻。
- **暂停 / 恢复**：暂停只冻结当前项的剩余毫秒数；恢复时以该余量建立新的绝对截止时刻，后续项依次累加。
- **延迟回调**：回调若因标签页降频迟到并跨过多项，引擎按各自截止时刻依次把每项记入轨迹（实际处理时刻为回调真实到达时刻），并把“当前应执行项”直接推进到第一个尚未到期的项。
- **错误处理**：未载入时启动、状态不符的重复操作（重复开始、未暂停时继续等）均就地报错，且不改变任何状态。
- **完成展示**：最后一项到期后界面稳定显示“已完成”，并列出全部提示的计划截止时间与实际处理时间——可直观看到一次长延迟虽造成集中处理，却没有延长整段演练。

## 测试

- `src/engine/engine.test.ts`（Vitest）：注入手动时钟，覆盖启动/暂停/恢复、延迟回调批量处理、截止时刻不漂移、全部状态错误。
- `src/engine/validate.test.ts`（Vitest）：清单校验的全部非法情形与整份拒绝。
- `e2e/rehearsal.spec.ts`（Playwright）：通过 `page.clock` 控制页面时间——`runFor` 模拟时间正常流逝，`fastForward` 模拟标签页降频后回调被延迟投递（等效于合上笔记本再打开），经真实页面验证导入校验、暂停/恢复、延迟回调集中处理、完成展示。
