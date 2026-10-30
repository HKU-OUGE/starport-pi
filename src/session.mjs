import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { privateDir } from "./config.mjs";
import { makeTools, decodeRead } from "./tools.mjs";

export const SYSTEM_PROMPT =
  "You are a coding assistant working in /workspace on the selected server. Use the available tools to inspect and edit the project, execute commands, manage jobs and access shared data. Commands are asynchronous: inspect their logs and final status before reporting success. The runtime uses Asia/Taipei, zh_TW.UTF-8 and UTF-8. Use Traditional Chinese or English for project documentation and messages. Do not claim that regional settings change the physical location or service eligibility.";
export const CHAT_SYSTEM_PROMPT =
  "You are an assistant in conversation-only mode. No filesystem or command-execution tools are available. Discuss, explain and draft content, but do not claim to have inspected files or executed commands. Respond in the language requested by the user.";

export async function makeSession(
  config,
  root,
  remote,
  { modelRuntime, streamFn, inMemory = false } = {},
) {
  const chat = config.mode === "chat",
    prompt = chat ? CHAT_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const directory = privateDir(path.join(root, "agent"));
  const cwd = privateDir(path.join(root, "empty-workbench"));
  const settings = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    skills: [],
    promptTemplates: [],
    themes: [],
    defaultTools: [],
    cacheWarming: "off",
    retry: { enabled: true, maxRetries: 2 },
    compaction: { enabled: true },
    defaultProjectTrust: "untrusted",
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
    systemPrompt: prompt,
    extensionFactories: [
      (pi) => {
        pi.on("before_agent_start", (event) => {
          event.systemPromptOptions.cwd = chat ? "/conversation" : "/workspace";
          event.systemPromptOptions.contextFiles = [];
          event.systemPromptOptions.skills = [];
          event.systemPromptOptions.forceSystemPrompt = prompt;
        });
        pi.on("user_bash", () => ({
          result: {
            output: "Use the remote bash tool.",
            exitCode: 1,
            cancelled: false,
            truncated: false,
          },
        }));
      },
    ],
  });
  await loader.reload();
  const runtime =
    modelRuntime ||
    (await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }));
  if (!modelRuntime) {
    const fs = await import("node:fs");
    const secret = JSON.parse(
      fs.readFileSync(path.join(root, "secrets.json"), "utf8"),
    );
    if (typeof secret.anthropicApiKey !== "string" || !secret.anthropicApiKey)
      throw new Error("configure_api_key_first");
    await runtime.setRuntimeApiKey("anthropic", secret.anthropicApiKey);
  }
  const model = runtime.getModel("anthropic", config.model);
  if (!model) throw new Error("model_not_available");
  const tools = chat ? [] : makeTools(remote);
  if (!chat) decodeRead(tools.find((t) => t.name === "read"));
  const sid = config.activeServer + "-" + config.workspace;
  const manager = inMemory
    ? SessionManager.inMemory(cwd)
    : SessionManager.continueRecent(cwd, path.join(root, "sessions", sid));
  const result = await createAgentSession({
    cwd,
    agentDir: directory,
    modelRuntime: runtime,
    model,
    thinkingLevel: config.effort,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
    tools: tools.map((t) => t.name),
    customTools: tools,
  });
  if (streamFn) result.session.agent.streamFunction = streamFn;
  return { ...result, tools, resourceLoader: loader };
}
