# 会话工具与扩展

在会话的 **工具与偏好** 中选择能力，点击 **应用**。输入 `/` 可搜索会话操作、项目工具、Skills、插件和 MCP；选择扩展后仍需应用。正在回复时不更换配置。

## 内置能力

| 能力 | 运行位置 | 配置 |
| --- | --- | --- |
| `web_search`、`web_fetch` | Anthropic 服务端 | 默认关闭；每个请求最多 1–10 次 |
| 代码执行、分析附件、生成文件 | Anthropic 容器 | 默认关闭；产物可预览、下载 |
| 顾问工具 | Anthropic 服务端 | 默认关闭；指定顾问模型，最多 3 次 / 请求 |
| 快速模式 | Anthropic 服务端 | 默认关闭；只接受已支持的 Opus 型号，按快速模式计价 |
| 提示词缓存 | Anthropic 服务端 | 默认 5 分钟，可关闭或选择 1 小时 |
| `read`、`write`、`list`、`find`、`grep`、`edit` | 已选项目的 worker | 纯聊天不提供这些工具 |
| `bash`、任务状态、日志、取消、产物、共享数据 | 已选项目的 worker | 命令返回任务 ID，结束前检查状态与日志 |

`find` / `grep` 有遍历和读取预算，返回截断标记；`grep` 是文字搜索，不执行用户正则。`edit` 在项目任务中进行唯一匹配替换，也返回任务 ID。模型不能调用管理电脑的 shell、订阅配置或凭据读取入口。

原生工具支持引用、工具结果和 `pause_turn` 接续；每轮最多自动接续两次，达到上限会给出明确状态，用户可继续下一轮。历史结果保存后可以重开会话接续。顾问的加密结果只保留给 API 重放，不显示为原始密文。

## 网络与文件

Pi → Anthropic API / Files API 继续走选定代理。代理不可用时请求失败，不切回直连。搜索、抓取和远端 MCP 的实际访问由 Anthropic 发出；它们的出口不由本机代理决定。工具定义不附带本机定位、环境变量、浏览器状态或账户身份元数据。

Anthropic 代码执行容器不自动挂载项目或管理电脑，且默认不联网。只有手动附加的文件及模型生成内容会进入该容器。读取已选服务器的网络信息仍只能经项目工具与现有任务代理进行。

上传的内容、文件名及原有文件元数据可能包含个人信息；本功能不做内容关键词拦截，也不声称隐藏 API 账户身份。不会自动启用邮件、通讯录、浏览器控制或本机文件系统连接器。

## 文字与附件

- 面板发送前把普通中文文字转为繁体；显示回复时转为简体。原始记录保留发送给 API 的文字，转换不另调模型。
- 代码块、行内代码、路径、网址和附件字节保持不变。它们可能含有简体；不会为了语言转换破坏程序或改写文件内容。
- Markdown 支持表格、任务清单、删除线、公式、代码复制、来源链接。整个回复包在 `markdown` 代码块时显示排版，并保留源文入口。
- JPEG / PNG / GIF / WebP：作为图片输入；每张最多 4 MiB。PDF：原生文档输入，每份最多 8 MiB。
- 文本、代码、CSV、JSON 等：1 MiB 以内直接作为文档输入。更大文本及 Office、压缩包等文件需开启代码执行，按 Files API 的文件附件传入。
- 会话附件单个及每条消息合计最多 20 MiB，最多 10 个；每会话本地附件最多 200 MiB。**项目文件页的大文件上传仍使用原有分块通道**，不受模型附件的 20 MiB 限制。
- 图片、音视频、PDF 提供浏览器预览或打开，其他格式提供下载。上传音视频或压缩包不代表模型自动理解其全部内容，需要代码执行中的实际解析。
- 附件分块校验、续传和下载按会话绑定；别的会话无法凭文件 ID 读取。代码执行产物只接受本会话 API 返回的文件 ID。
- 附件暂存保留以支持会话重放。Files API 文件不会被冒充为自动过期或自动删除；删除云端文件前需确认相关历史不再使用。

## 插件、Skill、MCP

管理面板 → **插件 / Skill / MCP**：

1. **Skills**：粘贴内容或导入 `SKILL.md`，可编辑、停用、删除。选中后以提示词提供给会话，不读取同目录其他文件或运行安装脚本。
2. **MCP**：填写公开 HTTPS 地址、专用 Bearer token 和工具名称允许列表。使用 Anthropic 远端 MCP 连接器，支持 Streamable HTTP / SSE；不支持管理电脑上的 stdio 进程。
3. **插件**：把已有 Skills 和 MCP 组合成可选工具包，支持声明式 JSON 导入 / 导出。不是任意 npm / Pi 扩展的执行入口，不运行本机 hooks。

MCP 的地址、专用 token 和调用参数会交给 Anthropic 连接器及该 MCP 服务。请按服务单独授权，不要填写 SSH 私钥、Cloudflare 管理凭据或服务器管理员凭据。返回的企业数据仍属于会话内容，工具本身不能保证不包含身份信息。

条目保存与会话启用分开。停用、修改或删除在下一轮生效，不打断已经发出的请求。加密配置包包含扩展配置及专用 token；导入后扩展保持停用，重新选择后使用。

插件文件示例：

```json
{
  "id": "research",
  "label": "研究工具包",
  "description": "结合来源审阅与公开搜索",
  "enabled": false,
  "skills": ["source-review"],
  "mcp": ["public-search"]
}
```

## 用量与余量

会话的 **用量** 页显示输入 / 输出 token、缓存读写、搜索 / 抓取次数、顾问调用及 token 费用估算，可切换到本工作台所有会话。原始 API 响应 ID 用于去重；顾问用量单独计入，不重复计算执行模型的迭代。

**速率限制余量**取自 API 响应头，并标注采集时间。它可能被同账户其他应用消耗，不是账户金额。**账户余额**不由 Messages API 提供，页面提供官方账单入口；不以限流剩余 token 推算美元余额。

费用使用当前安装的模型价格目录及快速模式价格估算，仅含 token，不含搜索、容器时长等额外费用；未知模型价格显示缺失，不当作免费。正式组织用量 / 成本接口需要另外的管理权限，本面板不会把管理凭据交给模型，也不会自动读取其他应用的用量。

官方参考：[搜索](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)、[抓取](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)、[代码执行](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)、[顾问](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)、[MCP](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)、[缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[快速模式](https://platform.claude.com/docs/en/build-with-claude/fast-mode)、[用量 API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)。
