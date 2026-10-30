import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";
import { Agent, fetch as operatorFetch } from "undici";
import { writePrivate } from "./config.mjs";

export function accessConfig(root) {
  const file = path.join(root, "access.json");
  if (!fs.existsSync(file)) return { mode: "local" };
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    c.mode !== "cloudflare" ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(c.issuer || "") ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(c.hostname || "") ||
    !c.audience ||
    !Array.isArray(c.allowedEmails) ||
    !c.allowedEmails.length
  )
    throw new Error("invalid_access_configuration");
  return c;
}
export const accessProof = (c) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify([c.issuer, c.audience, c.hostname, c.allowedEmails]))
    .digest("hex");
export function same(a, b) {
  const x = Buffer.from(String(a || "")),
    y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function localSecret(root) {
  const file = path.join(root, "panel-key.json");
  if (!fs.existsSync(file))
    writePrivate(file, { key: crypto.randomBytes(32).toString("hex") });
  return JSON.parse(fs.readFileSync(file, "utf8")).key;
}
export function localCookie(key) {
  return crypto
    .createHmac("sha256", key)
    .update("starport-panel-cookie-v1")
    .digest("hex");
}
export function csrfFor(key, identity) {
  return crypto
    .createHmac("sha256", key)
    .update("csrf:" + identity)
    .digest("hex");
}
export function requestPolicy(req, config, port) {
  const host = req.headers.host;
  if (["127.0.0.1:" + port, "localhost:" + port].includes(host)) {
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket?.remoteAddress,
    );
    const forwarded = Object.keys(req.headers).some(
      (name) =>
        name === "forwarded" || name === "via" ||
        name === "true-client-ip" || name.startsWith("x-forwarded-") ||
        name.startsWith("cf-"),
    );
    // cloudflared also connects over loopback. Peer IP alone is not proof of
    // local access: require a loopback Host and reject all forwarding markers.
    if (!loopback || forwarded) throw new Error("local_access_denied");
    return { mode: "local", origin: "http://" + host };
  }
  if (config.mode === "cloudflare" && host === config.hostname)
    return { mode: "cloudflare", origin: "https://" + config.hostname };
  throw new Error("host_not_allowed");
}
const keys = new Map();
const operatorDispatcher = new Agent();
export async function verifyAccess(token, c, { keySet } = {}) {
  if (typeof token !== "string" || token.length > 16384)
    throw new Error("authentication_required");
  // Management authentication is independent from the model-only dispatcher.
  if (!keySet) {
    if (!keys.has(c.issuer))
      keys.set(
        c.issuer,
        createRemoteJWKSet(new URL(c.issuer + "/cdn-cgi/access/certs"), {
          timeoutDuration: 5000,
          [customFetch]: (url, options) =>
            operatorFetch(url, { ...options, dispatcher: operatorDispatcher }),
        }),
      );
    keySet = keys.get(c.issuer);
  }
  const { payload } = await jwtVerify(token, keySet, {
    issuer: c.issuer,
    audience: c.audience,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "iat", "sub", "email"],
    clockTolerance: 5,
  });
  if (
    typeof payload.email !== "string" ||
    !c.allowedEmails.some(
      (e) => e.toLowerCase() === payload.email.toLowerCase(),
    )
  )
    throw new Error("access_denied");
  return payload.sub;
}
export async function authenticate(req, c, key, options = {}) {
  if (c.mode === "cloudflare")
    return verifyAccess(req.headers["cf-access-jwt-assertion"], c, options);
  const cookies = String(req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim());
  if (!cookies.some((x) => same(x, "starport_session=" + localCookie(key))))
    throw new Error("authentication_required");
  return "local-operator";
}
