# 创玩 · C++ 创作平台

创玩(CppPlay) 是一个本地部署的 C++ 创作平台：创作者用 **C++/SDL2** 写作品，平台用 **Emscripten** 编译成 WebAssembly，任何人都可以在浏览器里直接游玩。

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 后端 | Node.js 22+ · Express · 内置 SQLite(`node:sqlite`) · dockerode |
| 前端 | Next.js 15(App Router) · React 19 · TypeScript(strict) · Monaco(类 VSCode 编辑器) |
| 编译 | Emscripten(emcc) + SDL2 / SDL2_image / SDL2_ttf / SDL2_mixer 端口 |
| 仓库 | 每个作品一个独立 git 仓库(裸仓库 + 编辑器目录) |
| 构建 | 容器化安全构建(可选): Docker + 构建容器池, 平台侧 git 全部在容器内执行 |

## 目录结构

```
codingPlatform/
├── server/                 # 后端(对外唯一入口)
│   ├── src/
│   │   ├── index.js        # 服务入口
│   │   ├── start-all.js    # 生产启动器: 同进程拉起 Next.js standalone + Express
│   │   ├── app.js          # 应用工厂(依赖注入, 便于测试)
│   │   ├── config.js       # 配置中心(环境变量可覆盖)
│   │   ├── db.js           # 数据层(SQLite)
│   │   ├── git.js          # git 服务(本地/容器双模式: 仓库/分支/文件/提交/发布)
│   │   ├── compile.js      # 本地模式编译服务(开发/降级用)
│   │   ├── buildQueue.js   # 构建容器池 + 任务队列(热备/扩容/缩容/超时)
│   │   ├── dockerClient.js # Docker 客户端封装(unix socket / 命名管道 / tcp)
│   │   ├── publisher.js    # 发布流水线
│   │   ├── auth.js         # 账号系统(注册/邮箱验证/登录/密码)
│   │   ├── routes.js       # REST API + git-over-HTTP + 产物托管 + 前端反代
│   │   ├── webProxy.js     # 页面请求 -> Next.js(内部 3010)反向代理
│   │   ├── shell.html      # 作品构建外壳(全屏画布)
│   │   └── templates/sdl2/ # 新作品模板(SDL2 示例)
│   ├── Dockerfile          # 后端容器镜像(多阶段: Next.js 产物 + Node 运行时 + git)
│   ├── docker/             # 容器构建镜像(安全模式)
│   │   ├── Dockerfile      # emsdk + git + 离线预下载 SDL2 端口
│   │   ├── build.js        # 容器内构建脚本(导出快照 + 解析 compile.json + emcc)
│   │   └── build-image.sh  # 一键构建镜像(宿主机 Docker; 容器化部署时改用 compose)
│   ├── tests/              # 命令行测试(node --test)
│   └── data/               # 运行数据(仓库/数据库/产物, 自动生成)
├── web/                    # 前端(Next.js App Router + TypeScript)
│   ├── app/                # 页面与路由(SSR): 主页/全部/作品详情/创作者/编辑器/管理/登录
│   │   ├── page.tsx        # 主页(服务端渲染作品列表 + Hero)
│   │   ├── work/[id]/      # 作品详情页(SEO: metadata + JSON-LD)
│   │   ├── creator/[name]/ # 创作者主页(公开, SEO 收录)
│   │   ├── edit/[id]/      # 在线编辑器(Monaco 懒加载)
│   │   ├── sitemap.ts      # 动态 sitemap.xml
│   │   └── robots.ts       # robots.txt
│   ├── components/         # 顶栏/页脚/卡片/页签等
│   ├── lib/                # API 封装(客户端/服务端)/ 类型 / 认证 / 主题
│   ├── scripts/            # copy-monaco / prepare-standalone
│   └── public/monaco/      # Monaco 静态资源(构建时自动生成)
├── docker-compose.yml      # 容器化部署: 后端 + DinD(构建容器池的 Docker 引擎)
├── .dockerignore           # Docker 构建上下文排除项
└── scripts/install-emscripten.bat   # 本地模式工具链一键安装
```

## 快速开始

### 方式一: 容器化部署(推荐, 后端 + DinD 全容器化)

后端本身也跑在容器里, 通过 **DinD(Docker-in-Docker)** 管理构建容器池 ——
宿主机只需要一个 Docker 引擎(Docker Desktop 或 Linux Docker), 无需 Node/git/Emscripten。
前端代码不变, 产物在镜像构建时自动打入, 由后端同端口托管。

```bash
# 1. 构建后端镜像并启动 DinD + 后端(首次构建前端产物需几分钟)
docker compose up -d

# 2. 首次: 把构建镜像 cppplay-builder 装入 DinD 守护进程
#    (构建容器由后端经 DinD 创建, 镜像必须存在于 DinD 内部; 幂等可重复执行)
docker compose --profile tools run --rm builder-image

# 3. 访问 http://127.0.0.1:3000
```

数据与镜像均持久化在命名卷中(`server-data` / `dind-data`), 重启不丢失。
详见下文「容器化部署」一节。

### 方式二: 本地开发(宿主机运行)

```bash
# 1. 安装依赖
cd server && npm install
cd ../web && npm install

# 2. 生产模式: 构建前端(Next.js standalone 产物, 含 Monaco 静态资源)
cd ../web && npm run build

# 3. 启动平台(start-all.js 同进程拉起 Next.js 与 Express, 单端口 3000)
cd ../server && npm run start:all   # http://127.0.0.1:3000
#    (也可分开: npm start 仅启动后端; 构建模式自动探测 Docker/emcc)

# 开发模式(前端热更新):
#   终端 1: cd server && npm start          # 后端 3000(API/产物/git)
#   终端 2: cd web && npm run dev           # Next.js 3010(页面, 经 3000 反代访问)
#   浏览器统一访问 http://127.0.0.1:3000
```

### 端到端冒烟测试

生产栈启动后(`npm run start:all`), 可运行完整链路验证(注册→创作→发布→emcc 构建→SSR/SEO 输出):

```bash
cd server && node e2e-smoke.mjs
```

## 前端架构(Next.js 15 App Router)

**拓扑**: Express 是唯一对外入口(`PORT=3000`)—— `/api` / `/w`(作品产物) / `/git`(git-over-HTTP)
由 Express 直连处理(行为不变); 页面与静态资源由内部 Next.js 服务(3010)提供, Express 将其余请求
反向代理过去(开发模式代理 `next dev`, 生产模式代理 standalone `server.js`)。

```
浏览器 ──▶ Express:3000 ──┬─ /api /w /git 直连处理
                          └─ 其余页面 ──▶ Next.js:3010(SSR)
```

**SEO 优化**:
- 服务端渲染(SSR): 主页/全部作品/作品详情/创作者主页均服务端直出内容, 爬虫无需执行 JS
- 每页独立 `metadata`(标题/描述/OG/canonical); 作品页含 `CreativeWork` JSON-LD,
  创作者页含 `ProfilePage` JSON-LD, 主页含 `WebSite` 结构化数据
- 动态 `sitemap.xml`(收录全部已发布作品与创作者)与 `robots.txt`
- 语义化 HTML(`main`/`nav`/`article`/`time`)、`lang="zh-CN"`、无障碍(跳转链接/焦点环/ARIA)

**UX 优化**:
- 首屏 JS 仅 ~110KB(Monaco 编辑器仅在编辑器页懒加载, 其余页面零编辑器成本)
- 明亮/暗色双主题(跟随系统 + 手动切换, 无闪烁); 现代化 Hero + 渐变作品卡片
- 构建中/排队中自动轮询刷新(主页与作品页), 无需手动刷新
- 全局 loading/error 边界、骨架屏、移动端适配、`prefers-reduced-motion` 支持

## 容器化部署(Docker Compose)

**拓扑**: `server` 容器(后端)通过 `DOCKER_HOST=tcp://dind:2375` 连接 `dind` 容器
(Docker-in-Docker 守护进程), 构建容器池在 DinD 内部创建 —— 与宿主机 Docker 完全隔离。

```bash
docker compose up -d                        # 启动 DinD + 后端
# 常用操作:
docker compose ps                           # 查看状态
docker compose logs -f server               # 后端日志
docker compose --profile tools run --rm builder-image   # (重新)构建 cppplay-builder 装入 DinD
```

要点:
- **镜像构建进 DinD**: 构建容器由后端经 DinD 创建, 因此 `cppplay-builder` 镜像必须存在于
  DinD 守护进程内部, 而不是宿主机 Docker。`builder-image` 一次性服务完成这一件事
  (等价于在 DinD 内执行 `docker build -f server/docker/Dockerfile -t cppplay-builder .`)。
  更换构建镜像后重新执行 `docker compose --profile tools run --rm builder-image` 即可。
- **数据持久化**: 后端数据(`server/data`: 作品仓库 / 数据库 / 产物)挂载到命名卷
  `server-data`; DinD 的镜像与构建缓存挂载到 `dind-data`。删除卷即清空数据。
- **DinD 安全说明**: DinD 需要 `privileged: true`; 为本地部署关闭了 TLS
  (`DOCKER_TLS_CERTDIR=""`, 仅 compose 内网可达)。若部署到不可信网络,
  请启用 TLS(设置 `DOCKER_TLS_CERTDIR=/certs` 并给后端配 `DOCKER_TLS_VERIFY`)。
- **端口**: 后端 3000 映射到宿主机; 也可在 `docker-compose.yml` 里改端口或加 nginx 反代
  (反代场景设置 `TRUST_PROXY=1`)。
- **可选项**: 注册开关 / SMTP 邮件 / webhook 密钥等环境变量在 compose 的 `server` 服务中按需配置。

> 本地开发时若已在宿主机 Docker 里构建过 `cppplay-builder`, 它与 DinD 内部的镜像是两份独立副本,
> 互不影响; 两种部署方式(容器化 / 宿主机)数据目录也彼此独立, 不会串数据。

### 容器构建（安全模式，推荐生产部署）

平台侧 **git 处理与构建 100% 在容器内执行**，宿主机不运行任何处理用户仓库数据的 git 命令（外部 `git push` 的 receive-pack 除外）。

```bash
# 1. 构建镜像(首次): emsdk + git + 离线预下载 SDL2 端口 + 固化缓存副本
#    宿主机部署:
server/docker/build-image.sh   # 等价于 docker build -f server/docker/Dockerfile -t cppplay-builder .
#    容器化部署(DinD): 镜像必须装入 DinD 守护进程内部
#    docker compose --profile tools run --rm builder-image

# 2. 启动平台(自动探测 Docker; 或显式指定 BUILD_MODE=container)
BUILD_MODE=container npm start
#    容器化部署: docker compose up -d(compose 已内置 BUILD_MODE=container)
```

**容器池规格**：每个构建容器 1 核 / 2GB 内存 / 禁网(`--network none`) / 丢弃全部能力(`--cap-drop ALL`) / 非特权用户；后台热备 1 个、上限 3 个；排队任务超过 5 个自动扩容，队空 300 秒自动缩容；单次构建超时 60 秒（超时容器销毁重建）。构建繁忙时前端显示「服务器繁忙，你正在队伍第 N 位」。

**安全边界**：
- 正在构建的作品之间使用不同容器，同一时刻一个容器只服务一个作品的构建
- 构建容器**零宿主机挂载**：源码（裸仓库副本）与产物全部经 docker cp 进出，容器内运行的用户代码看不到宿主机任何路径
- 平台侧 git 操作在一次性容器内执行，只挂载目标作品的仓库/编辑器目录（作品间互不可见），用完即毁
- 每个构建任务使用独立 Emscripten 缓存副本（从镜像内 pristine 缓存拷贝），任务间零共享可变状态，恶意构建无法污染后续构建
- 产物落盘前去符号链接；编辑器目录文件操作逐级校验、拒绝符号链接

## 平台规则

- **构建与 Git Commit 绑定**：每次 main 推送都会触发一次构建，构建结果绑定到该提交。作品是否公开展示由「main 分支是否存在构建成功的提交」决定。
- **主页按最近更新时间推送**：最近 30 天内有更新、且 main 分支存在至少一个「构建成功」提交的作品出现在主页，按更新时间倒序。**不按热度排序，每个作品获得同等曝光**（响应中不包含任何热度字段）。
- **自己的主页分情况显示**：main 分支从未推送（没有发布提交）显示「私有」；有提交但绑定的构建失败显示「构建失败」；构建成功显示「已发布」；构建中显示「构建中」。
- **显示最近一次有效构建**：若 main 分支最近一次提交的构建未成功，作品页自动运行最近一次构建成功的版本（`/w/<id>/` 始终托管最近一次有效构建的产物）。
- **默认双分支**：新作品自动初始化 `develop` 与 `main` 两个分支（`main` 与初始提交对齐，可直接 `git push origin main`）。
- **git 推送 main 自动构建**：无论是 git 命令行推送 main，还是在线编辑器「发布」，都走同一条 post-receive hook → webhook → 构建流水线，行为完全一致。
- **develop 分支内部使用**：在线编辑器的「提交」写入 develop；git 命令行推送 develop 不会触发构建、不会公开作品。

## 创作方式（二选一）

### A. 在线编辑器（类 VSCode）

创作管理 → 创建作品 → 自动进入编辑器：

- 左侧文件树：新建 / 上传（到 `assets/`）/ 重命名 / 删除
- 右侧 Monaco：C++ 高亮、Ctrl/Cmd+S 保存（写入编辑器目录）
- 「提交」→ 提交到 develop 分支（内部）
- 「🚀 发布」→ develop 推送 main（触发构建 + 计一次更新；构建成功才会公开展示），底部日志实时显示构建状态

### B. git 命令行

```bash
git clone <平台给出的 remote 地址>
cd <作品ID>

# 日常开发(内部, 不公开)
git add -A && git commit -m "开发中"
git push origin develop

# 发布(触发自动构建; 构建成功才会公开展示 + 计一次更新)
git push origin develop:main
```

> 提示：两种方式共用同一个仓库，切换前先在编辑器里点「⇄ 同步」拉取外部推送；反之在编辑器提交后请先 `git pull`。
> 新作品自带 develop / main 双分支，`main` 被推送即触发构建，无需特殊处理首次发布。

## 作品构建（compile.json）

仓库根目录的 `compile.json` 可选，缺省规则为：编译仓库内所有 `.c/.cpp` 文件 + 启用 SDL2 + `-O2`；存在 `assets/` 目录时自动预加载。

```json
{
  "sources": ["main.cpp", "src/*.cpp"],
  "libraries": ["SDL2", "SDL2_image", "SDL2_ttf", "SDL2_mixer"],
  "flags": ["-O2", "-sALLOW_MEMORY_GROWTH=1"],
  "preload": ["assets"]
}
```

- `libraries` 支持：`SDL`(v1)、`SDL2`、`SDL2_image`、`SDL2_ttf`、`SDL2_mixer`
- 代码里用 `#include <SDL2/SDL.h>`（与 emscripten 官方测试一致）
- 主循环请用 `emscripten_set_main_loop`，不要用 while 死循环（会阻塞浏览器）
- 产物固定为 `index.html / index.js / index.wasm`，由平台托管在 `/w/<作品ID>/`

## 测试（命令行，后端）

```bash
cd server && npm test
```

- 40 个用例：API 全链路（创建→编辑→提交→发布→hook→构建→主页收录）、构建与提交绑定（失败回退最近一次有效构建 / 私有 / 重新构建）、主页 30 天规则、权限与路径安全、编译参数生成、工具链缺失降级、git 命令行推送触发发布（hook 全链路）、容器模式全链路（假 Docker 注入：队列/队伍位置/去重/扩容/缩容/超时/启动恢复/容器内 git 挂载与脚本断言/符号链接防护）等
- 全部在进程内完成：随机端口 + 独立临时数据目录，结束即清理，**不启动任何后台进程**
- 容器模式测试使用注入的假 Docker 客户端，不依赖真实 Docker；本机未安装 emcc 时，真实构建用例自动跳过（安装后自动恢复执行）

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 服务端口 |
| `DATA_DIR` | `server/data` | 数据目录（仓库/数据库/产物） |
| `HOME_WINDOW_DAYS` | 30 | 主页收录窗口（天） |
| `EMCC` | 自动探测 | 本地模式 emcc 完整路径 |
| `GIT_BASE_URL` | 空 | 对外 git 远程地址前缀（如 `ssh://user@host:2222`；为空时用本机文件路径） |
| `WEBHOOK_SECRET` | 空 | 内部 webhook 校验密钥（设置后 git hook 自动携带） |
| `PUBLIC_URL` | `http://127.0.0.1:PORT` | 对外访问地址(同时作为前端 SSR 数据回环地址与 SEO canonical/sitemap 基址) |
| `NEXT_INTERNAL_URL` | `http://127.0.0.1:3010` | 内部 Next.js 服务地址(Express 页面反代目标) |
| `NEXT_INTERNAL_PORT` | `3010` | start-all.js 拉起 Next.js standalone 时的内部端口 |
| `BUILD_MODE` | `auto` | 构建模式：`auto`（Docker 可用且镜像存在→容器，否则本地）/ `container`（强制容器）/ `local`（宿主机 emcc） |
| `BUILD_IMAGE` | `cppplay-builder:latest` | 构建容器镜像名 |
| `BUILD_TIMEOUT_MS` | `60000` | 单次构建超时（默认 60 秒） |
| `BUILD_WORKER_CPUS` | `1` | 构建容器 CPU 上限（核） |
| `BUILD_WORKER_MEM_MB` | `2048` | 构建容器内存上限（MB） |
| `BUILD_POOL_MIN` | `1` | 构建容器池下限（后台热备数） |
| `BUILD_POOL_MAX` | `3` | 构建容器池上限 |
| `BUILD_SCALE_UP_QUEUE` | `5` | 排队任务超过该数触发扩容 |
| `BUILD_SCALE_DOWN_MS` | `300000` | 队空持续该时长（ms）触发缩容 |
| `DOCKER_HOST` | 自动 | Docker 引擎地址：Linux 默认 unix socket `/var/run/docker.sock`，Windows 默认命名管道，也支持 `tcp://` |

## 实现要点

- **git hook 触发构建**：每个作品裸仓库装有 `post-receive` hook，main 收到推送即回调 `/api/internal/publish`，因此「git 命令行推送」与「在线编辑器发布」走同一条发布通道（编辑器发布在容器内 push 后由平台直接触发，publisher 内去重）。
- **构建与提交绑定**：构建结果记录在 builds 表并绑定到构建开始时的 main 头部提交；`artifacts/<id>/current` 始终是最近一次构建成功的产物，最新提交构建失败时作品页自然回退到最近一次有效构建。
- **容器模式：平台侧 git 全部容器化**：初始化/提交/发布推送/同步/历史/headSha 都在一次性容器内执行（只挂载目标作品仓库与编辑器目录，`--network none`、`--cap-drop ALL`、用完即毁）；宿主机唯一接触用户 git 数据的是外部 push 的 receive-pack。
- **构建容器池**：1 个后台热备、上限 3 个（1 核/2GB/禁网/非特权），排队超过 5 个任务扩容、队空 300 秒缩容；任务间彻底清理工作区并用独立缓存副本，正在构建的作品之间使用不同容器。
- **任务结束清扫（未持久化部分全部清除）**：宿主 `.staging-*` 临时产物目录仅在原子替换为 `current` 后保留，其余任何路径（提取失败/无状态文件/构建失败/异常）一律删除；容器内工作区每次任务后 `rm -rf`，清理失败则物理销毁整个容器；失败/超时/异常任务（容器内执行过用户代码）直接销毁容器重建，杜绝跨任务污染；常驻容器日志轮转（json-file 5MB×2）；启动时清理上次进程残留的孤儿构建容器（按 `cppp.platform=build-worker` 标签）与 `.staging-*` 目录。
- **零宿主机挂载**：构建容器内没有宿主机路径——裸仓库经 tar 拷入、产物经 tar 拷出，容器内运行的用户代码无法访问宿主机其他作品的数据。
- **编辑器目录不是 git worktree**：若用 worktree 检出 develop，外部 git 推送到 develop 会被 git 以「branch is currently checked out」拒绝；平台改用普通目录 + `git --git-dir/--work-tree` 直接提交，保证外部推送畅通。
- **导出快照不用 worktree**：构建用 `git read-tree + checkout-index`（私有临时索引）把 main 快照物化到临时目录；容器模式下这一步发生在构建容器内部（见 `docker/build.js`）。
- **离线构建**：构建容器运行期禁网，SDL2/SDL2_image/SDL2_ttf/SDL2_mixer 端口与系统库在镜像构建期预下载预编译进缓存，镜像内固化 pristine 副本供每个任务拷贝使用。
- **符号链接防护**：编辑器目录由容器内 git 物化，恶意仓库可植入符号链接；宿主机文件操作逐级校验并拒绝符号链接，产物落盘前也会清理符号链接（静态托管同时禁用 followSymlinks）。
- **构建失败不阻断发布流程**：main 推送即计一次更新（更新时间刷新），但「公开展示」只认构建成功；构建状态与日志单独记录，可一键「重新构建」。
- **启动恢复**：进程重启后，上次退出时处于「排队中/构建中」的作品自动重新入队构建，状态不会永久卡死。
- **无热度设计**：作品接口不提供浏览量等字段，主页卡片大小一致、按时间倒序，实现「人人平等曝光」。
