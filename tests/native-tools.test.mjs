import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeSession } from "../src/session.mjs";
import {
  NativeCollector,
  nativeDefinition,
  nativeView,
} from "../src/native-tools.mjs";
import { Addons, features } from "../src/addons.mjs";
import { UsageStore, usageRecord } from "../src/usage.mjs";
import {
  Attachments,
  AnthropicFiles,
  attachmentMarker,
} from "../src/attachments.mjs";
import { toTraditional } from "../src/chinese.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "starport-native-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("Files API uses multipart on the fixed API transport and reuses uploaded Office files", async () => {
  const root = tmp(),
    old = getGlobalDispatcher(),
    net = new MockAgent();
  net.disableNetConnect();
  setGlobalDispatcher(net);
  try {
    fs.writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({ anthropicApiKey: "example-key" }),
    );
    net
      .get("https://api.anthropic.com")
      .intercept({
        path: "/v1/files",
        method: "POST",
        headers: { "content-type": /multipart\/form-data; boundary=/ },
      })
      .reply(
        200,
        { id: "file_example" },
        { headers: { "content-type": "application/json" } },
      );
    const files = new AnthropicFiles(root),
      a = new Attachments(root, "c".repeat(32), { files }),
      bytes = Buffer.from("PK-office-fixture");
    const u = a.begin({
      name: "book.xlsx",
      bytes: bytes.length,
      sha256: sha(bytes),
    });
    a.chunk({
      upload: u.id,
      offset: 0,
      data: bytes.toString("base64"),
      sha256: sha(bytes),
    });
    a.finish({ upload: u.id });
    for (let i = 0; i < 2; i++) {
      const p = await a.inject(
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: attachmentMarker(u.id) }],
            },
          ],
        },
        { codeExecution: true },
      );
      assert.ok(p.betas.includes("files-api-2025-04-14"));
      assert.equal(p.messages[0].content[1].file_id, "file_example");
      assert.ok(!JSON.stringify(p).includes("example-key"));
    }
    net.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(old);
    await net.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function sse(id, blocks, stop = "end_turn") {
  const events = [
    {
      type: "message_start",
      message: {
        id,
        role: "assistant",
        type: "message",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_read_input_tokens: 20,
        },
      },
    },
  ];
  blocks.forEach((b, i) => {
    events.push(
      { type: "content_block_start", index: i, content_block: b },
      { type: "content_block_stop", index: i },
    );
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: {
        input_tokens: 100,
        output_tokens: 15,
        cache_read_input_tokens: 20,
        server_tool_use: { web_search_requests: id === "msg_1" ? 1 : 0 },
      },
    },
    { type: "message_stop" },
  );
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

test("actual SDK replays hosted tools and citations across pause, next prompt and disk reload", async () => {
  const root = tmp(),
    previous = getGlobalDispatcher(),
    net = new MockAgent(),
    requests = [];
  net.disableNetConnect();
  setGlobalDispatcher(net);
  let session;
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(root, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    await runtime.setRuntimeApiKey("anthropic", "example-test-key");
    const blocks = [
      {
        type: "server_tool_use",
        id: "srvtoolu_search",
        name: "web_search",
        input: { query: "public example" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_search",
        content: [
          {
            type: "web_search_result",
            title: "Example",
            url: "https://example.com",
            encrypted_content: "opaque-provider-data",
          },
        ],
      },
      {
        type: "text",
        text: "找到資料。",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com",
            title: "Example",
            encrypted_index: "opaque",
            cited_text: "Example",
          },
        ],
      },
    ];
    for (let i = 0; i < 4; i++)
      net
        .get("https://api.anthropic.com")
        .intercept({ path: /\/v1\/messages.*/, method: "POST" })
        .reply((opts) => {
          const p = JSON.parse(opts.body);
          requests.push(p);
          return {
            statusCode: 200,
            data: sse(
              "msg_" + (i + 1),
              i === 0 ? blocks : [{ type: "text", text: "驗證完成。" }],
              i === 0 ? "pause_turn" : "end_turn",
            ),
            responseOptions: {
              headers: {
                "content-type": "text/event-stream",
                "anthropic-ratelimit-requests-remaining": "17",
                "anthropic-organization-id": "must-not-persist",
              },
            },
          };
        });
    const config = {
      mode: "chat",
      activeServer: "chat",
      workspace: "a".repeat(32),
      sessionId: "b".repeat(32),
      model: "claude-sonnet-5-5",
      effort: "off",
      features: { webSearch: true },
    };
    session = (await makeSession(config, root, null, { modelRuntime: runtime }))
      .session;
    await session.prompt("請搜尋公開資料。");
    assert.equal(requests.length, 2);
    assert.equal(session.messages.at(-1).stopReason, "stop");
    assert.equal(
      session.messages.at(-1).native.sources[0].url,
      "https://example.com",
    );
    assert.ok(
      requests[1].messages.some((m) =>
        m.content?.some((b) => b.type === "web_search_tool_result"),
      ),
    );
    await session.prompt("繼續分析。");
    assert.ok(
      requests[2].messages.some((m) =>
        m.content?.some((b) => b.type === "web_search_tool_result"),
      ),
    );
    session.dispose();
    session = (await makeSession(config, root, null, { modelRuntime: runtime }))
      .session;
    await session.prompt("重新開啟後繼續。");
    assert.ok(
      requests[3].messages.some((m) =>
        m.content?.some((b) => b.type === "web_search_tool_result"),
      ),
    );
    for (const p of requests) {
      assert.equal(p.metadata, undefined);
      assert.ok(!JSON.stringify(p).includes("STARPORT_REPLAY_"));
      assert.ok(!JSON.stringify(p).includes(root));
      assert.equal(p.cache_control.type, "ephemeral");
      assert.ok(p.tools.some((t) => t.type === "web_search_20250305"));
      assert.ok(!p.tools.some((t) => t.name === "bash"));
    }
    const usage = new UsageStore(root).snapshot();
    assert.equal(usage.total.requests, 4);
    assert.equal(usage.total.input_tokens, 400);
    assert.equal(usage.total.webSearch, 1);
    assert.equal(
      usage.rateLimits["anthropic-ratelimit-requests-remaining"],
      "17",
    );
    assert.ok(!JSON.stringify(usage).includes("must-not-persist"));
  } finally {
    session?.dispose();
    setGlobalDispatcher(previous);
    await net.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native collector handles JSON deltas, citations, redacted advice, output grants and cost without double-counting", () => {
  const c = new NativeCollector();
  c.event({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "server_tool_use",
      id: "srv1",
      name: "advisor",
      input: {},
    },
  });
  c.event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"query":"x"}' },
  });
  c.event({ type: "content_block_stop", index: 0 });
  assert.deepEqual(c.blocks[0].input, { query: "x" });
  const v = nativeView([
    ...c.blocks,
    {
      type: "advisor_tool_result",
      tool_use_id: "srv1",
      content: { type: "advisor_redacted_result", encrypted_content: "secret" },
    },
    {
      type: "bash_code_execution_tool_result",
      content: { content: [{ file_id: "file_abc" }] },
    },
  ]);
  assert.equal(v.tools[0].status, "complete");
  assert.ok(!JSON.stringify(v).includes("secret"));
  assert.deepEqual(v.files, ["file_abc"]);
  const row = usageRecord({
    id: "x",
    model: "executor",
    usage: {
      input_tokens: 1760,
      output_tokens: 531,
      iterations: [
        { type: "message", input_tokens: 412 },
        {
          type: "advisor_message",
          model: "advisor",
          input_tokens: 823,
          output_tokens: 1612,
        },
        { type: "message", input_tokens: 1348 },
      ],
    },
    headers: {},
    costForModel: () => ({ input: 3, output: 15 }),
  });
  assert.equal(row.input_tokens, 2583);
  assert.equal(row.output_tokens, 2143);
  assert.equal(row.advisor.length, 1);
  assert.ok(row.estimatedTokenUsd > 0);
  const cached = usageRecord({
    id: "cache",
    model: "claude-sonnet-5-5",
    usage: { cache_read_input_tokens: 1000000 },
    headers: {},
    costForModel: () => ({ input: 2, output: 10, cacheRead: 0.1 }),
  });
  assert.equal(cached.estimatedTokenUsd, 0.1);
  const fast = usageRecord({
    id: "fast",
    model: "claude-opus-5-5",
    usage: {
      speed: "fast",
      input_tokens: 1000000,
      cache_read_input_tokens: 1000000,
    },
    headers: {},
    requestedSpeed: "fast",
  });
  assert.equal(fast.estimatedTokenUsd, 8.4);
});

test("pause continuation cap stops automatic requests without destroying resumable history", async () => {
  const root = tmp(),
    previous = getGlobalDispatcher(),
    net = new MockAgent(),
    requests = [];
  net.disableNetConnect();
  setGlobalDispatcher(net);
  let session;
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(root, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    await runtime.setRuntimeApiKey("anthropic", "example-test-key");
    for (let i = 0; i < 4; i++)
      net
        .get("https://api.anthropic.com")
        .intercept({ path: /\/v1\/messages.*/, method: "POST" })
        .reply((opts) => {
          requests.push(JSON.parse(opts.body));
          return {
            statusCode: 200,
            data: sse(
              "pause_" + i,
              [{ type: "text", text: "Step " + i }],
              i < 3 ? "pause_turn" : "end_turn",
            ),
            responseOptions: {
              headers: { "content-type": "text/event-stream" },
            },
          };
        });
    session = (
      await makeSession(
        {
          mode: "chat",
          activeServer: "chat",
          workspace: "d".repeat(32),
          model: "claude-sonnet-5-5",
          effort: "off",
          features: { webFetch: true },
        },
        root,
        null,
        { modelRuntime: runtime, inMemory: true },
      )
    ).session;
    await session.prompt("Continue the public task.");
    assert.equal(requests.length, 3);
    assert.equal(session.messages.at(-1).native.paused, true);
    assert.equal(session.messages.at(-1).stopReason, "stop");
    await session.prompt("Continue.");
    assert.equal(requests.length, 4);
    assert.equal(session.messages.at(-1).native.paused, false);
    const replay = requests[3].messages.find((m) => m.role === "assistant");
    assert.equal(replay.content.filter((b) => b.type === "text").length, 3);
  } finally {
    session?.dispose();
    setGlobalDispatcher(previous);
    await net.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills, declarative plugins and MCP are opt-in; secrets and host commands never enter public definitions", () => {
  const root = tmp();
  try {
    const a = new Addons(root);
    a.save("skills", {
      id: "review",
      label: "Review",
      content: "Check sources",
      enabled: true,
    });
    a.save("mcp", {
      id: "research",
      label: "Research",
      url: "https://mcp.example.com/mcp",
      tools: ["search"],
      token: "example-private-token",
      enabled: true,
    });
    a.save("plugins", {
      id: "bundle",
      label: "Bundle",
      description: "Research bundle",
      skills: ["review"],
      mcp: ["research"],
      enabled: true,
    });
    assert.ok(!JSON.stringify(a.list()).includes("example-private-token"));
    const selected = a.resolve({ plugins: ["bundle"] });
    assert.equal(selected.skills.length, 1);
    const def = nativeDefinition(
      { plugins: ["bundle"] },
      selected,
      "claude-sonnet-5-5",
    );
    assert.equal(def.servers[0].authorization_token, "example-private-token");
    assert.equal(def.tools[0].default_config.enabled, false);
    assert.deepEqual(a.resolve({}).mcp, []);
    assert.throws(
      () =>
        a.save("plugins", {
          id: "bad",
          label: "Bad",
          description: "x",
          skills: [],
          mcp: [],
          command: "sh",
        }),
      /declarative/,
    );
    for (const url of [
      "http://example.com",
      "https://127.0.0.1",
      "https://localhost",
      "https://host.internal",
      "https://user:pass@example.com",
    ])
      assert.throws(
        () => a.save("mcp", { id: "bad", label: "Bad", url, tools: ["x"] }),
        /https/,
      );
    assert.throws(() => features({ cache: "forever" }), /cache/);
    assert.throws(
      () => nativeDefinition({ fast: true }, {}, "claude-sonnet-5-5"),
      /not_supported/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attachments resume, verify, stay session-scoped and inject supported API blocks without host paths", async () => {
  const root = tmp();
  try {
    const a = new Attachments(root, "a".repeat(32)),
      other = new Attachments(root, "b".repeat(32));
    const b = Buffer.from("hello,world\n1,2"),
      u = a.begin({ name: "sample.csv", bytes: b.length, sha256: sha(b) });
    const input = {
      upload: u.id,
      offset: 0,
      data: b.toString("base64"),
      sha256: sha(b),
    };
    a.chunk(input);
    a.chunk(input);
    a.finish({ upload: u.id });
    assert.equal(
      a.begin({ name: "sample.csv", bytes: b.length, sha256: sha(b) }).offset,
      b.length,
    );
    assert.throws(() => other.item(u.id), /not_found/);
    const p = await a.inject(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Read " + attachmentMarker(u.id) }],
          },
        ],
      },
      { codeExecution: false },
    );
    assert.equal(p.messages[0].content[1].type, "document");
    assert.equal(p.messages[0].content[1].source.data, b.toString());
    assert.ok(!JSON.stringify(p).includes(root));
    await assert.rejects(
      () =>
        other.inject(
          {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: attachmentMarker(u.id) }],
              },
            ],
          },
          { codeExecution: false },
        ),
      /not_found/,
    );
    a.register(["../secret"]);
    assert.deepEqual(a.read().cloud, {});
    const file = a.begin({
      name: "book.xlsx",
      bytes: 2,
      sha256: sha(Buffer.from("PK")),
    });
    a.chunk({
      upload: file.id,
      offset: 0,
      data: Buffer.from("PK").toString("base64"),
      sha256: sha(Buffer.from("PK")),
    });
    a.finish({ upload: file.id });
    assert.throws(() => a.validate([file.id], false), /code_execution/);
    await assert.rejects(() => a.cloud("file_other"), /not_found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prompt conversion preserves executable spans, URLs and paths", () => {
  const result = toTraditional(
    "请检查网络，输出报告。`简体变量` https://example.com/简体 /workspace/简体.py\n```python\nprint('简体')\n```",
  );
  assert.ok(result.startsWith("請檢查網絡，輸出報告。"));
  assert.ok(result.includes("`简体变量`"));
  assert.ok(result.includes("print('简体')"));
  assert.ok(result.includes("https://example.com/简体"));
  assert.equal(toTraditional("输入/的时候显示工具"), "輸入/的時候顯示工具");
});
