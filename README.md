# Creality 打印机监控

[![CI](https://github.com/catmargiela/creality-printer-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/catmargiela/creality-printer-monitor/actions/workflows/ci.yml)
[![Python](https://img.shields.io/badge/python-3.12%20%7C%203.13-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-26%20tools-8A2BE2)](https://modelcontextprotocol.io)
[![Creality](https://img.shields.io/badge/Creality-Hi%20%7C%20K1%20%7C%20K2-1E90FF)](https://www.creality.com)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#docker)
[![Platforms](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](#requirements)

面向 Creality OS 3D 打印机（**Creality Hi、K1 系列、K2 系列、K3**）的本地 Web 控制面板**及 MCP 服务**。
它使用与 Creality Print 相同的协议直接连接局域网内的打印机，**无需 Creality 云账户**。

- **自动发现局域网打印机**；即使路由器重新分配 IP，也能再次找到打印机。
- 一个面板管理所有打印机：实时摄像头、进度、温度、剩余时间和已加载耗材。
- 暂停、继续、停止、灯光、温度（包括多喷嘴独立控温）、风扇、速度、轴移动和 G-code 控制台。
- 拖放文件即可上传打印，也可以将同一个文件发送到多台打印机。
- 使用 Creality Print 官方配置对 `.stl`、`.3mf`、`.obj`、`.step` 文件切片，并提供 3D 预览。
- 打印历史和费用统计（耗材与电费）、月度统计、维护提醒。
- 支持智能插座（Shelly、Tasmota）：打印完成且喷嘴冷却后自动断电。
- 提供清晰的错误信息和处理建议（耗材用尽、AI spaghetti 检测、堵头、断电等）。
- **通过 Claude 控制全部功能**（或使用其他 MCP 客户端）：查看状态、读取摄像头、开始/停止打印、上传文件等。

## 支持的打印机

| 打印机                          | 状态与控制 | 摄像头            |
|----------------------------------|------------------|-------------------|
| Creality Hi                      | ✅               | ✅ WebRTC (go2rtc) |
| K2 / K2 Plus / K2 Pro            | ✅               | ✅ WebRTC (go2rtc) |
| K3                               | ✅               | ✅ WebRTC (go2rtc) |
| K1 / K1C / K1 SE / K1 Max        | ✅               | ✅ MJPEG           |
| 其他 Creality OS 打印机（9999 端口 WebSocket） | 应该可以工作 | 取决于型号 |

传统 Marlin 打印机（Ender-3、Ender-3 V2 等）没有网络 API，因此暂不支持。

## 环境要求

- Python **3.12+** 和 pip（或 Docker）。
- 运行应用的电脑必须与打印机处于**同一网络**。
- 支持 Linux、macOS 和 Windows。摄像头网关 [go2rtc](https://github.com/AlexxIT/go2rtc) 会根据系统和 CPU 自动下载，并校验文件哈希。
- 可选：[Creality Print](https://www.creality.com/download) 7.3+，用于在应用中切片模型文件。将 `CREALITY_PRINT` 设置为其可执行文件路径。

## 快速开始

从代码仓库克隆后使用 pip 安装：

```bash
git clone https://github.com/catmargiela/creality-printer-monitor
cd creality-printer-monitor
python -m venv .venv
# Linux / macOS:
. .venv/bin/activate
# Windows PowerShell:
# .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python run.py
```

打开 <http://localhost:8000>（手机连接同一 Wi-Fi 时，可访问 `http://<电脑IP>:8000`）。

首次打开时，应用会要求创建**管理员账户**（用户名和密码）。之后在同一页面登录，登录会话有效期为 30 天。

首次启动时，应用会**扫描局域网**并添加发现的 Creality 打印机。
之后可以通过 **+ 打印机** 按 IP 添加，或再次执行网络扫描。
建议在路由器中为每台打印机设置固定 IP（DHCP 地址保留）。即使 IP 变化，应用也会根据 MAC 地址跟踪打印机。

### Docker

Linux 主机需要使用 host 网络模式，应用才能扫描局域网并访问摄像头：

```bash
docker compose up -d
```

数据（打印机列表、历史记录和下载的工具）保存在 `./data` 中。

## 从 Claude 使用（MCP）

应用会在 `http://<电脑IP>:8000/mcp/` 提供 MCP 服务（Streamable HTTP），使用前必须先启动应用。

**Claude Code**

```bash
claude mcp add --transport http creality-printers http://127.0.0.1:8000/mcp/
```

**Claude Desktop**（需要 Node.js）。编辑 `claude_desktop_config.json`
（macOS：`~/Library/Application Support/Claude/`，Windows：`%APPDATA%\Claude\`），然后重启 Claude Desktop：

```json
{
  "mcpServers": {
    "creality-printers": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.14.3", "http://127.0.0.1:8000/mcp/", "--allow-http", "--transport", "http-only"]
    }
  }
}
```

如果 Claude 运行在另一台电脑上，将 `127.0.0.1` 替换为运行应用的电脑 IP。
此时还需要允许对应的主机名：`PM_MCP_HOSTS=my-pc.local`。

**stdio**（同一台电脑上的任意 MCP 客户端）：

```json
{
  "command": "/absolute/path/to/creality-printer-monitor/.venv/bin/python",
  "args": ["/absolute/path/to/creality-printer-monitor/run_mcp.py"]
}
```

Windows 使用 `.venv\\Scripts\\python.exe` 作为命令。
如果应用不是运行在 `http://127.0.0.1:8000`，请设置 `PM_URL`。本地 stdio 服务会使用
令牌文件 `data/.mcp-token` 自动完成认证（启动时自动创建，目录与 `PM_DATA_DIR` 相同），因此不需要密码。

### 工具

| 类别     | 工具 |
|--------------|-------|
| 打印机     | `list_printers`、`printer_status`、`discover_printers`、`add_printer` |
| 摄像头     | `camera_snapshot`（返回 Claude 可以检查的图片，例如 spaghetti、空热床等） |
| 打印       | `start_print`、`pause_print`、`resume_print`、`stop_print`、`clear_error` |
| 文件       | `list_files`、`send_file`（本地路径或 URL；STL/3MF 会被切片）、`delete_file`、`slicer_profiles` |
| 控制       | `set_temperatures`、`set_fan`、`set_light`、`set_speed`、`move_axis`、`home_axes`、`send_gcode` |
| 记录       | `print_history`、`print_stats`、`maintenance`、`mark_maintenance_done` |
| 电源       | `plug_power` |

示例指令：*“现在有打印机正在打印吗？”*、*“拍一张 K1 的照片，告诉我打印是否正常”*、
*“将 ~/Downloads/benchy.stl 使用 PLA 切片，如果热床为空就在 Hi 上打印”*。

## 远程访问

请**不要**在路由器上开放端口：打印机 API 没有身份验证。
请在运行应用的电脑和手机上使用 [Tailscale](https://tailscale.com)（或其他 VPN），
然后即可从任意位置打开 `http://<电脑名称>:8000`。摄像头画面也会通过应用转发。
你也可以使用登录账户保护应用本身（参见[账户和角色](#账户和角色)）。
脚本和远程 MCP 客户端可以使用 `PM_PASSWORD` 通过 HTTP Basic 认证：

```bash
PM_PASSWORD='change-me' python run.py
```

## 账户和角色

Web 界面提供登录页面，会话存储在 SQLite 数据库中。

- **首次运行**：打开 `/` 会跳转到 `/setup`，在此创建第一个**管理员**账户。
- **管理员（admin）**：拥有全部权限，包括添加/编辑打印机、上传、控制、切片、维护、智能插座、
  G-code 控制台、删除历史记录，以及**设置 → 用户管理**（创建用户、重置密码、修改角色）。
- **普通用户（user）**：完全**只读**，只能访问监控、耗材、打印任务、温度和最近打印。其他 API 请求会返回 `403`，
  并且对应功能不会显示在界面中。

在**设置 → 用户管理**中管理用户。密码以加盐 PBKDF2 哈希保存；删除用户或修改密码会立即使其会话失效。

机器接口不使用登录页面：脚本、`curl` 和远程 MCP 客户端通过 HTTP Basic 认证
（`PM_PASSWORD` 授予**管理员**权限，其他用户名必须匹配数据库账户），或使用请求头
`X-PM-Token: <data/.mcp-token>`。Web 会话 Cookie 不能用于 Basic 形式的 API 请求。

## 配置

| 变量              | 默认值                 | 说明 |
|-----------------------|-------------------------|---------|
| `PM_PORT`             | `8000`                  | HTTP 端口 |
| `PM_HOST`             | `0.0.0.0`               | 监听地址 |
| `PM_PASSWORD`         | *(无)*                  | 机器密码（脚本、远程 MCP）：HTTP Basic 认证，拥有**管理员**权限 |
| `PM_DATA_DIR`         | 操作系统用户数据目录¹ | SQLite 数据库、照片、go2rtc 和切片器数据目录 |
| `PM_CONFIG`           | `$PM_DATA_DIR/printers.json` | 打印机列表 |
| `PM_SCAN_SUBNET`      | 自动（默认网卡的 `/24`） | 要扫描的子网，例如 `192.168.0.0/23` |
| `PM_MCP_HOSTS`        | *(无)*                 | 允许访问 `/mcp/` 的其他主机名/IP |
| `PM_URL`              | `http://127.0.0.1:8000` | stdio MCP 服务使用的应用地址 |
| `CREALITY_PRINT`      | 自动                    | Creality Print 可执行文件路径 |
| `SLICER_BACKEND`      | `creality`              | 仅兼容旧版 OrcaSlicer 时设置为 `orca` |
| `GO2RTC`              | 自动下载                | go2rtc 可执行文件路径 |
| `PM_GO2RTC_API_PORT`  | `19840`                 | go2rtc 本地 API 端口 |
| `PM_GO2RTC_RTSP_PORT` | `19554`                 | go2rtc 本地 RTSP 端口 |

¹ Linux `~/.local/share/creality-printer-monitor`, macOS `~/Library/Application Support/creality-printer-monitor`,
Windows `%APPDATA%\creality-printer-monitor`.

## 工作原理

应用使用 Creality Print / OrcaSlicer 使用的本地协议：

| 功能                 | 打印机端点 |
|----------------------|------------------|
| 状态与命令           | WebSocket `ws://<ip>:9999` |
| 发现打印机           | 扫描子网内每个地址的 TCP 9999，然后请求 `GET http://<ip>/info`（型号和 MAC） |
| 上传文件             | `POST http://<ip>/upload/<name>` |
| 开始打印             | `{"opGcodeFile": "printprt:<gcode dir>/<name>"}` |
| 摄像头（Hi / K2）    | WebRTC `http://<ip>:8000/call/webrtc_local`，由 go2rtc 打开并由应用转码为 JPEG |
| 摄像头（K1）         | MJPEG `http://<ip>:8080/?action=stream`，由应用转发 |
| 缩略图               | `http://<ip>/downloads/humbnail/<name>.png`（原接口拼写如此） |
| 错误信息             | `err.key` / `errcode`，使用 Creality Print 错误表（`creality_errors.json`）映射 |

代码结构（`src/printermonitor/`）：`printer.py`（打印机连接）、`server.py`（Web API）、`mcp_server.py`（MCP 工具）、
`discovery.py`（网络扫描）、`camera.py` + `go2rtc.py`（摄像头转发）、`slicer.py`（Creality Print）、`history.py` + `store.py`
（历史记录、设置、SQLite）、`plugs.py`（智能插座）、`errors.py`（错误信息）。Web 界面是 `frontend/` 中的 React
应用（3D 查看器和模型图片位于 `frontend/public/`）；启动服务前执行一次
`cd frontend && npm install && npm run build` 构建前端，Docker 会自动完成构建。

### 摄像头说明

- 未正常关闭的 WebRTC 摄像头会话可能会**锁定 Creality Hi 摄像头，直到打印机重启**。
  因此应用每台打印机只建立一个摄像头连接，并且只在有人观看时打开，结束观看后正确关闭。
- 如果摄像头持续不可用，请在打印机页面使用**重置摄像头**；如果仍无效，请断电重启打印机。

## 免责声明

这是一个独立项目，与 Creality 没有隶属或授权关系。它会向真实设备发送真实命令
（加热、移动、打印），请自行承担使用风险，切勿让打印机在无人看管的情况下运行。

## 许可证

[MIT](LICENSE)。包含 [three.js](https://threejs.org)（MIT）。运行时下载 [go2rtc](https://github.com/AlexxIT/go2rtc)（MIT），
并可选使用 [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer)（AGPL-3.0）；这些组件均不随项目重新分发。
