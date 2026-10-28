# 饭点了 · 午餐大转盘

面向个人用户的午餐选择程序。打开就能转，预算点标签，口味和商圈按需选择。

这是一套可运行的前后端项目：页面、样式、交互程序和美食数据分别存放；新增、删除私藏由 Node.js 服务写入 JSON 文件。

## 启动程序

需要 **Node.js 20 或更新版本**。项目使用 Node.js 内置模块，没有第三方运行依赖，无需先执行 `npm install`。

```bash
git clone https://github.com/lln2332/Let-s-Eat.git
cd Let-s-Eat
npm start
```

打开 <http://127.0.0.1:3000>。macOS 也可以双击仓库中的 **启动午餐大转盘.command**。

停止服务：在终端按 `Ctrl+C`。如果端口被占用，可运行：

```bash
PORT=3001 npm start
```

页面的读取和保存需要本项目的运行服务，请通过上面的服务地址访问。开发时可使用 `npm run dev` 自动重启服务。

## 项目结构

```text
Let-s-Eat/
├── server.mjs                 # 运行入口：网页服务、美食 API、文件保存
├── package.json               # npm start / npm test / npm run check
├── package-lock.json
├── 启动午餐大转盘.command      # macOS 双击启动
├── public/
│   ├── index.html             # 页面结构
│   ├── styles.css             # UI 与手机适配
│   └── app.js                 # 转盘、筛选、私藏与接口调用
├── data/
│   ├── restaurants.json       # 实际读取、写入的美食名单
│   ├── sources.json           # 内置美食的资料来源
│   └── README.md              # 数据字段和维护说明
└── test/
    └── server.test.mjs        # 持久化、重启、并发与接口测试
```

## 美食保存在哪里

**`data/restaurants.json` 是实际数据文件**，内置 46 家美食。页面新增的私藏会写入这里，删除私藏也会更新这个文件；刷新页面、停止程序或重启服务后仍会保留。服务只有保存成功才会提示“收好啦”，失败时会保留输入并显示错误。

可以通过页面维护私藏，也可以直接编辑数据文件，格式和字段见 [data/README.md](data/README.md)。手工维护时先停止服务，修改后再启动。备份时保存 `data/restaurants.json` 与 `data/sources.json`。

同一服务实例的美食名单由访问它的浏览器共享。个人预算、口味偏好、跳过记录和用餐足迹继续保存在各自浏览器里。旧版浏览器私藏在同一浏览器、同一访问地址下首次打开时会尝试迁移到文件，并避免重复导入；不同域名、端口或 `file://` 页面的浏览器存储不能自动互读。

如需将数据放到独立目录（例如持久化磁盘），可运行：

```bash
LETS_EAT_DATA_DIR=/absolute/path/to/lunch-data npm start
```

目录第一次使用时会复制内置名单；后续直接读取和写入该目录的 `restaurants.json`。

## 接口

| 方法 | 地址 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 服务及数据文件检查 |
| GET | `/api/restaurants` | 读取美食名单 |
| POST | `/api/restaurants` | 新增私藏，最少传入 `name` |
| DELETE | `/api/restaurants/:id` | 删除私藏 |
| POST | `/api/restaurants/import` | 幂等迁移旧浏览器私藏 |

新增示例：

```bash
curl -X POST http://127.0.0.1:3000/api/restaurants \
  -H 'Content-Type: application/json' \
  -d '{"name":"楼下烧腊饭","type":"米饭简餐","zone":"其他周边","low":20,"high":35}'
```

## 检查

```bash
npm run check
npm test
```

测试使用独立临时数据目录，不会改动正式美食名单，覆盖新增与删除后重启、重复记录、错误数据、并发保存、旧数据迁移、手工文档维护和跨来源写入。

预算为每人参考估算；出发前请在地图确认位置、营业和菜单。
