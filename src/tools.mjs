import { Type } from "typebox";

const text = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  details: {},
});
const p = Type.String({ minLength: 1, maxLength: 1024 });
const job = Type.String({ pattern: "^[a-f0-9]{32}$" });
const schema = (properties) =>
  Type.Object(properties, { additionalProperties: false });
export function makeTools(remote) {
  const tool = (name, description, parameters, operation, map = (x) => x) => ({
    name,
    label: name,
    description,
    parameters,
    async execute(_id, args, signal) {
      try {
        return text(await remote.call(operation, map(args), { signal }));
      } catch (e) {
        return { ...text({ error: e.message }), isError: true };
      }
    },
  });
  return [
    {
      name: "server_status",
      label: "Server",
      description: "Read the selected server capacity and regional profile.",
      parameters: schema({}),
      async execute() {
        const r = await remote.call("health");
        return text({
          ready: r.ready,
          cpus: r.cpus,
          memory_gib: r.memory_gib,
          gpus: r.gpus,
          region: r.region,
          network_ready: r.egress_ready,
        });
      },
    },
    tool(
      "read",
      "Read a UTF-8 project file. Paths are relative to /workspace.",
      schema({ path: p }),
      "file.read",
      (x) => ({ ...x, size: 2 * 1024 * 1024 }),
    ),
    tool(
      "write",
      "Write a UTF-8 project file in the remote workspace.",
      schema({ path: p, content: Type.String({ maxLength: 2 * 1024 * 1024 }) }),
      "file.write",
    ),
    tool(
      "list",
      "List files in the remote project.",
      schema({ path: Type.Optional(p) }),
      "file.list",
    ),
    projectSearch(remote, false),
    projectSearch(remote, true),
    {
      name: "edit",
      label: "Edit",
      description:
        "Replace one exact text occurrence in a project file inside a remote job. Fails if the text is missing or ambiguous. Returns a job ID; inspect job_status and job_logs.",
      parameters: schema({
        path: p,
        oldText: Type.String({ minLength: 1, maxLength: 262144 }),
        newText: Type.String({ maxLength: 262144 }),
      }),
      async execute(_id, args, signal) {
        const encoded = Buffer.from(JSON.stringify(args)).toString("base64");
        const script = `import base64,json,pathlib,tempfile,os\na=json.loads(base64.b64decode('${encoded}'))\nroot=pathlib.Path('/workspace')\np=(root/a['path']).resolve()\nassert p.is_relative_to(root) and p.is_file(), 'invalid_project_file'\nassert p.stat().st_size<=2097152, 'file_too_large'\ns=p.read_text()\nassert s.count(a['oldText'])==1, 'edit_match_missing_or_ambiguous'\ns=s.replace(a['oldText'],a['newText'],1)\nfd,tmp=tempfile.mkstemp(dir=p.parent)\nwith os.fdopen(fd,'w') as f: f.write(s)\nos.chmod(tmp,p.stat().st_mode & 0o777)\nos.replace(tmp,p)\nprint('edit_complete')`;
        try {
          return text(
            await remote.call(
              "job.submit",
              {
                command:
                  "python3 -c " + "'" + script.replaceAll("'", "'\\''") + "'",
                cpus: 1,
                memory_gib: 1,
                timeout: 60,
              },
              { signal },
            ),
          );
        } catch (e) {
          return { ...text({ error: e.message }), isError: true };
        }
      },
    },
    {
      name: "bash",
      label: "Remote command",
      description:
        "Start a shell command on the selected isolated server. Returns a job ID immediately; use job_status and job_logs. No local shell is available.",
      parameters: schema({
        command: Type.String({ minLength: 1, maxLength: 131072 }),
        cpus: Type.Optional(Type.Integer({ minimum: 1, maximum: 512 })),
        memory_gib: Type.Optional(Type.Integer({ minimum: 1, maximum: 2048 })),
        gpus: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
        timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400 })),
        datasets: Type.Optional(Type.Array(job, { maxItems: 16 })),
      }),
      async execute(_id, args, signal) {
        try {
          return text(await remote.call("job.submit", args, { signal }));
        } catch (e) {
          return { ...text({ error: e.message }), isError: true };
        }
      },
    },
    tool(
      "job_status",
      "Read computation state and confirmed resource release.",
      schema({ job }),
      "job.status",
    ),
    tool(
      "job_logs",
      "Read incremental UTF-8 logs. Reuse the returned byte cursor.",
      schema({ job, cursor: Type.Optional(Type.Integer({ minimum: 0 })) }),
      "job.logs",
    ),
    tool(
      "job_cancel",
      "Cancel only the specified job in this workspace.",
      schema({ job }),
      "job.cancel",
    ),
    tool(
      "artifacts",
      "List files in a job output directory, including running jobs.",
      schema({ job }),
      "job.artifacts",
    ),
    tool(
      "artifact_read",
      "Read a bounded result-file chunk; bytes are base64 with SHA-256.",
      schema({
        job,
        path: p,
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        size: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 2 * 1024 * 1024 }),
        ),
      }),
      "artifact.read",
    ),
    tool(
      "datasets",
      "List published immutable datasets.",
      schema({}),
      "dataset.list",
    ),
    tool(
      "dataset_publish",
      "Publish a remote project directory as a new read-only dataset version.",
      schema({ path: p }),
      "dataset.publish",
    ),
  ];
}

function projectSearch(remote, contents) {
  return {
    name: contents ? "grep" : "find",
    label: contents ? "Search contents" : "Find files",
    description: contents
      ? "Search literal text in bounded UTF-8 project files; returns file and line matches. Binary and large files are skipped."
      : "Find project paths containing the supplied text. Bounded recursive listing; never reads operator files.",
    parameters: schema({
      query: Type.String({ minLength: 1, maxLength: 300 }),
      path: Type.Optional(p),
    }),
    async execute(_id, args, signal) {
      const queue = [args.path || "."],
        matches = [];
      let scanned = 0,
        read = 0,
        truncated = false;
      try {
        while (queue.length && scanned < 1000 && matches.length < 100) {
          signal?.throwIfAborted();
          const parent = queue.shift();
          const rows = await remote.call(
            "file.list",
            { path: parent },
            { signal },
          );
          for (const f of rows.entries || []) {
            const name = (parent === "." ? "" : parent + "/") + f.name;
            scanned++;
            if (scanned > 1000 || matches.length >= 100) {
              truncated = true;
              break;
            }
            if (!contents && name.includes(args.query))
              matches.push({ path: name, kind: f.kind });
            if (
              f.kind === "directory" &&
              name.split("/").length < 8 &&
              ![".git", "node_modules", ".venv"].includes(f.name)
            )
              queue.push(name);
            if (
              contents &&
              f.kind === "file" &&
              f.bytes <= 512 * 1024 &&
              read + f.bytes <= 4 * 1024 * 1024
            ) {
              const row = await remote.call(
                "file.read",
                { path: name, size: 512 * 1024 },
                { signal },
              );
              read += row.bytes;
              const b = Buffer.from(row.data, "base64");
              if (b.includes(0)) continue;
              b.toString("utf8")
                .split("\n")
                .forEach((line, i) => {
                  if (matches.length < 100 && line.includes(args.query))
                    matches.push({
                      path: name,
                      line: i + 1,
                      text: line.slice(0, 1000),
                    });
                });
            } else if (contents && f.kind === "file") truncated = true;
          }
        }
        return text({
          matches,
          scanned,
          truncated: truncated || queue.length > 0 || matches.length >= 100,
        });
      } catch (e) {
        return { ...text({ error: e.message }), isError: true };
      }
    },
  };
}

export function decodeRead(tool) {
  const original = tool.execute;
  tool.execute = async (...args) => {
    const result = await original(...args);
    if (result.isError) return result;
    const data = JSON.parse(result.content[0].text);
    if (data.total > 2 * 1024 * 1024)
      return text({ error: "file_too_large_use_remote_command" });
    return {
      content: [
        {
          type: "text",
          text: Buffer.from(data.data, "base64").toString("utf8"),
        },
      ],
      details: {},
    };
  };
  return tool;
}
