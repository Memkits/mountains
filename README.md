# 吉隆口岸 WebGPU 3D 地形

面向桌面版 Chrome 的静态 WebGPU 地形演示。场景以吉隆口岸（`28.27972° N, 85.37778° E`）为起点，结合真实 DEM、卫星影像、流式 LOD、灾害路径、国境线、路线与地名标注，支持 PS5 DualSense 手柄飞行浏览。

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

构建结果位于 `dist/client/`，不依赖 Node.js 服务端、数据库或 API 路由，可直接部署到 GitHub Pages 或任意静态文件托管服务。

## Google Satellite 密钥

Google Map Tiles API Key 是浏览器侧地图访问凭据，**不得提交到 Git**。`.env*` 已被 `.gitignore` 忽略，仓库只保留不含值的 [.env.example](.env.example)。

本地开发可选地创建 `.env.local`：

```bash
cp .env.example .env.local
```

未设置环境变量时，页面首次加载地图会以 `prompt()` 请求 Key，并只保存在当前浏览器的 `localStorage`；取消则自动使用 OpenTopoMap。获取方式：

1. 打开 Google Cloud Console 的“API 和服务 → 凭据”。
2. 创建 API Key，并启用 **Map Tiles API**。
3. 为 Key 设置 HTTP referrer 限制：本地可用 `http://localhost:3001/*`；生产环境填写 GitHub Pages 域名。

GitHub Pages 工作流读取组织或仓库 Actions Secret `VITE_GOOGLE_MAPS_API_KEY`。即使使用 Secret，Web 地图 Key 在浏览器请求中仍可见，因此必须限制 API、来源域名与配额；Secret 的作用是避免 Key 出现在源码与 Git 历史中。

## 控制

- 鼠标拖拽环视，滚轮缩放；`W / A / S / D` 平移，`Q / E` 升降。
- 全屏模式保留地形、场景标注、左上角指北针和“AI 协助生成演示”说明；按 `Esc` 退出。
- DualSense：左摇杆前后移动、左右转向；右摇杆按相机局部横轴/纵轴平移；方向键控制俯仰/滚转（上下已按视觉直觉对调）；`L2 / R2` 缩放；`L3` 朝北，`R3` 回到吉隆口岸。
- `L1 / R1` 分别提供 16× 平移倍率，双键为 256×；旋转倍率为 2× / 4×。仅左右转向围绕相机前方约 8 米的支点。
- `□` 扫描当前视野内的城市、水系与高原地标；飞离或转出视野后自动隐藏。
- `○` 隐藏/恢复全部场景标记、国界线、灾害通道与路线覆盖，只保留地图地形。

## 地图与性能

- 高程来自 Mapzen Terrain Tiles 的 Terrarium RGB DEM；近景为 Z12 流式窗口，采用四档屏幕空间 LOD。
- Google Satellite 优先，OpenTopoMap 为无 Key 或失败时的后备来源。近、中、远地形使用逐级降低的影像层级与网格密度。
- Z10 地平线层填补约 240 km 的远景；摄像机升至约 20 km 后额外启用 Z8、7×7 分段的超低精度层，覆盖约 900 km，并在下降后自动回收。
- 静止 0.9 秒后渲染自动降至 30 FPS；交互时恢复 60 FPS。渲染像素比上限为 1.5，以降低高分屏 GPU 负担。
- 导航图层包含吉隆周边、国内城市、西藏地名、尼泊尔城市、湖泊/河流、珠穆朗玛峰，以及成都—吉隆的 G318 → G349/G216 节点路线。国际边界严格只显示中国—尼泊尔与中国—印度，用于场景方位参考，不作法定国界依据。

## GitHub Pages

工作流位于 [.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml)。向 `main` 推送会构建 `dist/client/` 并部署到 GitHub Pages。

首次启用时，在仓库 Settings → Pages 中选择 **GitHub Actions** 作为发布源；如组织提供 Key，则设置组织 Secret `VITE_GOOGLE_MAPS_API_KEY` 并允许本仓库访问。未配置 Secret 的页面仍可运行，并会在浏览器中提示用户提供受限 Key 或回退到 OpenTopoMap。
