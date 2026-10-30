import { createSHA256 } from "hash-wasm";
import { api } from "./api";

export async function uploadFile({
  session,
  file,
  directory = ".",
  attachment = false,
  progress,
}) {
  progress("计算校验值 · " + file.name);
  const hash = await createSHA256();
  hash.init();
  for (let offset = 0; offset < file.size; offset += 1048576)
    hash.update(
      new Uint8Array(await file.slice(offset, offset + 1048576).arrayBuffer()),
    );
  const sha256 = hash.digest("hex"),
    route = attachment ? "attach" : "upload";
  const destination = attachment
    ? file.name
    : (directory === "." ? "" : directory + "/") + file.name;
  const resumeKey =
    "starport-" +
    route +
    "-" +
    session +
    "-" +
    sha256 +
    "-" +
    encodeURIComponent(destination);
  let grant;
  try {
    grant = JSON.parse(sessionStorage.getItem(resumeKey));
  } catch {}
  if (!grant) {
    grant = await api(`sessions/${session}/${route}-begin`, {
      name: file.name,
      bytes: file.size,
      sha256,
      ...(!attachment ? { directory } : {}),
    });
    sessionStorage.setItem(resumeKey, JSON.stringify(grant));
  }
  while (grant.offset < file.size) {
    const data = new Uint8Array(
      await file.slice(grant.offset, grant.offset + 1048576).arrayBuffer(),
    );
    hash.init();
    hash.update(data);
    let binary = "";
    for (let i = 0; i < data.length; i += 32768)
      binary += String.fromCharCode(...data.subarray(i, i + 32768));
    const r = await api(`sessions/${session}/${route}-chunk`, {
      upload: grant.id,
      offset: grant.offset,
      data: btoa(binary),
      sha256: hash.digest("hex"),
    });
    grant.offset = r.offset;
    sessionStorage.setItem(resumeKey, JSON.stringify(grant));
    progress(
      `${file.name} · ${Math.round((grant.offset / Math.max(file.size, 1)) * 100)}%`,
    );
  }
  const done = await api(`sessions/${session}/${route}-finish`, {
    upload: grant.id,
  });
  if (done.sha256 !== sha256) throw new Error("upload_checksum");
  sessionStorage.removeItem(resumeKey);
  return done;
}
