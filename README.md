# WebGPU 山体地形查看器

面向桌面版 Chrome 的静态三维山体地形查看器。它结合真实 DEM、卫星影像、流式 LOD、地名/水系/路线标注与 PS5 DualSense 手柄浏览，可从默认坐标开始，并随时跳转到任意经纬度。

## 运行

需要 Node.js 22 或更高版本，以及已开启硬件加速的 Chrome。

```bash
npm ci
npm run dev
```

生产静态构建：

```bash
npm run build:static
npm run preview
```

构建结果位于 `dist/client/`，不依赖 Node.js 服务端、数据库或 API 路由，可部署到任意静态文件服务器。

## 跳转到坐标

右侧控制面板提供“跳转至经纬度”输入框（WGS 84）。默认经纬度已预填；输入纬度 `-85` 至 `85`、经度 `-180` 至 `180` 后点击“跳转观察”即可重新加载该区域的地形与影像。

## Google Satellite 密钥

Google Map Tiles API Key 是浏览器侧地图访问凭据，**不得提交到 Git**。`.env*` 已被 `.gitignore` 忽略，仓库只保留不含值的 [.env.example](.env.example)。

本地开发可选地创建 `.env.local`：

```bash
cp .env.example .env.local
```

未设置环境变量时，页面首次加载地图会以 `prompt()` 请求 Key，并只保存在当前浏览器的 `localStorage`；取消则自动使用 OpenTopoMap。获取方式：

1. 打开 Google Cloud Console 的“API 和服务 → 凭据”。
2. 创建 API Key，并启用 **Map Tiles API**。
3. 为 Key 设置 HTTP referrer 限制：本地可用 `http://localhost:3001/*`；生产环境填写实际部署站点域名。

部署工作流读取组织或仓库 Actions Secret `VITE_GOOGLE_MAPS_API_KEY`。即使使用 Secret，Web 地图 Key 在浏览器请求中仍可见，因此必须限制 API、来源域名与配额；Secret 的作用是避免 Key 出现在源码与 Git 历史中。

## 控制

- 鼠标拖拽环视，滚轮缩放；`W / A / S / D` 平移，`Q / E` 升降。
- 全屏模式保留地形、场景标注、左上角指北针和“AI 协助生成演示”说明；按 `Esc` 退出。
- DualSense：左摇杆前后移动、左右转向；右摇杆按相机局部横轴/纵轴平移；方向键控制俯仰/滚转（上下已按视觉直觉对调）；`L2 / R2` 缩放；`L3` 朝北，`R3` 回到默认观察点。
- `L1 / R1` 分别提供 16× 平移倍率，双键为 256×；旋转倍率为 2× / 4×。仅左右转向围绕相机前方约 8 米的支点。
- `□` 扫描当前视野内的城市、水系与高原地标；飞离或转出视野后自动隐藏。
- `○` 隐藏/恢复全部场景标记、边界线、灾害通道与路线覆盖，只保留地图地形。

## 地图与性能

- 高程来自 Mapzen Terrain Tiles 的 Terrarium RGB DEM；近景为 Z12 流式窗口，采用四档屏幕空间 LOD。
- Google Satellite 优先，OpenTopoMap 为无 Key 或失败时的后备来源。近、中、远地形使用逐级降低的影像层级与网格密度。
- Z10 地平线层填补约 240 km 的远景；摄像机升至约 20 km 后额外启用 Z8、7×7 分段的超低精度层，覆盖约 900 km，并在下降后自动回收。
- 静止 0.9 秒后渲染自动降至 30 FPS；交互时恢复 60 FPS。渲染像素比上限为 1.5，以降低高分屏 GPU 负担。
- 地图标注包含城市、湖泊、河流、高原地标与主干路线；国际边界仅用于场景方位参考，不作法定边界依据。

## 服务器部署

工作流位于 [.github/workflows/deploy-server.yml](.github/workflows/deploy-server.yml)。向 `main` 推送会构建 `dist/client/`，再通过 `rsync` 上传至已配置的服务器目录。

服务器凭据沿用项目原有的组织或仓库 Secret `rsync_private_key`；地图 Key 使用 `VITE_GOOGLE_MAPS_API_KEY`。未配置地图 Key 的页面仍可运行，并会在浏览器中提示用户提供受限 Key 或回退到 OpenTopoMap。
