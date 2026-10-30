let csrf = "",
  admin = "";
export function setCsrf(value) {
  csrf = value;
}
export function setAdmin(value) {
  admin = value;
}
export async function api(path, data, signal) {
  const r = await fetch("/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers:
      data === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Starport-CSRF": csrf,
            ...(admin ? { "X-Starport-Admin": admin } : {}),
          },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal,
    cache: "no-store",
  });
  const value = await r.json();
  if (!r.ok) {
    const e = new Error(value.error || "request_failed");
    e.status = r.status;
    throw e;
  }
  return value;
}
export const setup = (action, values = {}) =>
  api("setup", { action, ...values });
export const fileUrl = (id, path, job) =>
  "/api/sessions/" +
  id +
  "/download?" +
  new URLSearchParams({ path, ...(job ? { job } : {}) });
