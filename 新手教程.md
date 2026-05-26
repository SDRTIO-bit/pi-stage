# RP Engine · 新手教程

## 🚀 新手教程（5 分钟上手）

### 准备工作
- **Node.js 18+** — 没装的话去 [nodejs.org](https://nodejs.org/) 下载安装
- **pi coding agent** — 终端运行 `npm install -g @earendil-works/pi-coding-agent`
- **一张角色卡** — SillyTavern 格式的 .png 或 .json 角色卡（去社区找或者自己制作）

---

### 第一步：部署项目

**方式一：一键部署（推荐）**
双击根目录的 **`项目部署.bat`**，自动完成：
```
✔ 检查 Node.js → 安装依赖 → 安装 pi agent
```

**方式二：手动部署**
```bash
npm install                     # 安装项目依赖
npm install -g @earendil-works/pi-coding-agent  # 安装 pi agent
```

---

### 第二步：导入角色卡

拿到一张 .png 角色卡后，导入到引擎：

**方式一：拖拽导入（推荐）**
把 .png 文件拖到 **`ImportCharacterCard.bat`** 上松手即可。

**方式二：命令行导入**
```bash
node setup.mjs --import 角色卡.png
```

导入完成后，终端会显示卡片信息和世界书条目数。想确认有哪些卡片：
```bash
# 启动 pi 后输入：
/card list
```

---

### 第三步：启动引擎

```bash
pi
```

首次启动会加载引擎，看到 `RP模式` 提示表示成功。

---

### 第四步：开始角色扮演

在 pi 中输入以下命令激活你的角色卡：

```
/card activate <卡片id>
```
（卡片 id 在导入时终端有显示，也可以用 `/card list` 查看）

激活后就可以直接对话了！AI 会自动读取角色设定和世界书开始扮演。

> **提示**：首次进入新场景时，AI 会先调用 `load_constant_worldbook` 读取世界观设定，耐心等几轮就好。

---

### 第五步：打开 Web 界面（可选）

浏览器打开 **http://localhost:3012**，可以看到：
- 实时对话界面
- 角色状态面板
- 历史会话管理
- 世界书条目浏览

---

### 常用命令速查

| 命令 | 作用 |
|------|------|
| `/card list` | 查看所有已导入的卡片 |
| `/card activate <id>` | 激活卡片，开始扮演 |
| `/card deactivate <id>` | 休眠卡片 |
| `/reset` | 重置角色数值到初始状态 |
| `/status` | 查看所有角色当前状态 |
| `/rp` | 查看帮助 |

---

### 常见问题

**Q: 提示 "pi 命令不存在"**
A: 确认已执行 `npm install -g @earendil-works/pi-coding-agent`，然后重启终端。

**Q: 导入卡片时报错**
A: 确保角色卡是 SillyTavern V2/V3 格式的 .png 或导出的 .json 文件。

**Q: 怎么切换角色卡？**
A: `/card deactivate <当前id>` 取消激活，再 `/card activate <新id>` 激活新卡，然后重启 pi。

**Q: Web 界面打不开**
A: 确认 pi 正在运行，浏览器访问 http://localhost:3012

---
