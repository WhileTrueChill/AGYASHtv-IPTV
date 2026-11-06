const { Readable } = require("node:stream");
const crypto = require("node:crypto");

const ALLOWED_ACTIONS = new Set([
  "get_live_categories",
  "get_live_streams",
  "get_vod_categories",
  "get_vod_streams",
  "get_series_categories",
  "get_series",
  "get_series_info",
]);
const ALLOWED_KINDS = new Set(["live", "movie", "series"]);
const ALLOWED_EXTENSIONS = new Set(["ts", "m3u8", "mp4", "mkv", "avi", "mov", "mpg", "mpeg"]);
const SESSION_COOKIE = "agyashtv_session";
const SESSION_TTL_SECONDS = 4 * 60 * 60;

function getSessionKey() {
  const secret = String(process.env.XTREAM_SESSION_SECRET || "");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("XTREAM_SESSION_SECRET is not configured.");
  }
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function encryptPayload(payload, ttlSeconds = SESSION_TTL_SECONDS) {
  const key = getSessionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ ...payload, expiresAt: Date.now() + ttlSeconds * 1000 }), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function decryptPayload(token) {
  try {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length < 30) return null;
    const key = getSessionKey();
    const iv = bytes.subarray(0, 12);
    const tag = bytes.subarray(12, 28);
    const body = bytes.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decoded = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const payload = JSON.parse(decoded);
    if (!payload || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSessionCookie(providerBase, username, password) {
  const token = encryptPayload({ type: "session", providerBase, username, password });
  const secure = process.env.AGYASHTV_LOCAL_DESKTOP === "1" ? "" : " Secure;";
  return `${SESSION_COOKIE}=${token}; Path=/api/xtream; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly;${secure} SameSite=Lax`;
}

function expireSessionCookie() {
  const secure = process.env.AGYASHTV_LOCAL_DESKTOP === "1" ? "" : " Secure;";
  return `${SESSION_COOKIE}=; Path=/api/xtream; Max-Age=0; HttpOnly;${secure} SameSite=Lax`;
}

function readCookie(req, name) {
  const cookieHeader = String(req.headers.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

function readWebSession(req) {
  const session = decryptPayload(readCookie(req, SESSION_COOKIE));
  if (session?.type !== "session" || !session.providerBase || !session.username || !session.password) return null;
  return { providerBase: String(session.providerBase), username: String(session.username), password: String(session.password) };
}

function createTargetToken(target) {
  return encryptPayload({ type: "stream-target", url: String(target) });
}

function readTargetToken(token) {
  const payload = decryptPayload(String(token || ""));
  if (payload?.type !== "stream-target" || typeof payload.url !== "string") return null;
  try { return new URL(payload.url); } catch { return null; }
}

function getBase(value) {
  const input = String(value || "").trim().replace(/\/+$/, "");
  if (!input) throw new Error("Enter your IPTV server URL.");
  const base = new URL(input);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Provider URL must use HTTP or HTTPS and cannot contain embedded credentials.");
  const host = base.hostname.toLowerCase();
  if (["localhost", "localhost.localdomain"].includes(host) || host.endsWith(".localhost") || host.endsWith(".local") || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) throw new Error("Private or local server addresses are not supported.");
  return base;
}

function allowedStreamHosts(base) {
  const hosts = new Set([base.hostname.toLowerCase()]);
  for (const entry of String(process.env.XTREAM_ALLOWED_STREAM_HOSTS || "").split(",")) {
    const candidate = entry.trim();
    if (!candidate) continue;
    try {
      const host = candidate.includes("://") ? new URL(candidate).hostname : candidate;
      if (/^[a-zA-Z0-9.-]+$/.test(host)) hosts.add(host.toLowerCase());
    } catch {
      // Ignore malformed optional host entries.
    }
  }
  return hosts;
}

function isAllowedTarget(target, base, hosts = allowedStreamHosts(base)) {
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) return false;
  if (!hosts.has(target.hostname.toLowerCase())) return false;
  if (target.origin === base.origin) return true;
  // Optional CDN hosts are only allowed on their standard HTTP(S) ports.
  return (target.protocol === "https:" && (!target.port || target.port === "443")) ||
    (target.protocol === "http:" && (!target.port || target.port === "80"));
}

async function fetchAllowedTarget(target, headers, base) {
  const hosts = allowedStreamHosts(base);
  let current = new URL(target);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    if (!isAllowedTarget(current, base, hosts)) {
      throw new Error("Provider stream host is not allow-listed.");
    }
    const response = await fetch(current, { headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: current };
    }
    const location = response.headers.get("location");
    if (!location) return { response, url: current };
    await response.body?.cancel().catch(() => {});
    current = new URL(location, current);
  }
  throw new Error("Provider redirect limit exceeded.");
}

function encode(value) {
  return encodeURIComponent(String(value || ""));
}

function makePlayerApiUrl(base, username, password, action, params = {}) {
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${basePath}/player_api.php`, base.origin);
  url.searchParams.set("username", String(username));
  url.searchParams.set("password", String(password));
  if (action) url.searchParams.set("action", action);
  if (action === "get_series_info" && params.series_id != null) {
    url.searchParams.set("series_id", String(params.series_id));
  }
  return url;
}

function streamProxyUrl(target) {
  const proxy = new URL("/api/xtream", "https://proxy.invalid");
  proxy.searchParams.set("mode", "remote");
  proxy.searchParams.set("target", createTargetToken(target));
  return proxy.pathname + proxy.search;
}

async function pipeUpstream(req, res, upstream, contentType) {
  res.statusCode = upstream.status;
  res.setHeader("Content-Type", contentType || upstream.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  for (const header of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      if (body.logout) {
        res.setHeader("Set-Cookie", expireSessionCookie());
        return res.status(200).json({ ok: true });
      }

      const base = getBase(body.providerBase);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const action = body.action ? String(body.action) : "";
      const params = body.params || {};
      if (!username || !password) return res.status(400).json({ error: "Enter your username and password." });
      if (action && !ALLOWED_ACTIONS.has(action)) return res.status(400).json({ error: "Unsupported provider action." });
      if (action === "get_series_info" && !/^\d+$/.test(String(params.series_id || ""))) {
        return res.status(400).json({ error: "Invalid series ID." });
      }

      const url = makePlayerApiUrl(base, username, password, action, params);
      const { response: upstream } = await fetchAllowedTarget(url, { Accept: "application/json" }, base);
      if (!upstream.ok) return res.status(502).json({ error: "The IPTV provider could not complete the request." });
      const data = await upstream.json();

      // Establish a short-lived encrypted HttpOnly session only after a valid browser login.
      if (!action && Number(data?.user_info?.auth) === 1) {
        try {
          res.setHeader("Set-Cookie", createSessionCookie(base.toString().replace(/\/+$/, ""), username, password));
        } catch (error) {
          if (error instanceof Error && error.message === "XTREAM_SESSION_SECRET is not configured.") {
            return res.status(503).json({ error: "Web sessions are not configured. Add XTREAM_SESSION_SECRET in Vercel." });
          }
          throw error;
        }
      }
      return res.status(200).json(data);
    }

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed." });
    }

    const session = readWebSession(req);
    if (!session) return res.status(401).json({ error: "Your web session expired. Please sign in again." });
    const base = getBase(session.providerBase);
    const { username, password } = session;
    const q = req.query || {};
    const mode = String(q.mode || "");

    let target;
    if (mode === "stream") {
      const kind = String(q.kind || "");
      const id = String(q.id || "");
      const ext = String(q.ext || "mp4").toLowerCase();
      if (!ALLOWED_KINDS.has(kind) || !/^\d+$/.test(id) || !ALLOWED_EXTENSIONS.has(ext)) {
        return res.status(400).json({ error: "Invalid stream request." });
      }
      const pathKind = kind === "movie" ? "movie" : kind === "series" ? "series" : "live";
      const basePath = base.pathname.replace(/\/+$/, "");
      target = new URL(`${basePath}/${pathKind}/${encode(username)}/${encode(password)}/${encode(id)}.${ext}`, base.origin);
    } else if (mode === "remote") {
      target = readTargetToken(q.target);
      if (!target) return res.status(400).json({ error: "The stream link is invalid or expired. Please reopen the stream." });
      if (!isAllowedTarget(target, base)) {
        return res.status(403).json({ error: "Blocked stream target. Configure an allowed provider/CDN host if required." });
      }
    } else {
      return res.status(400).json({ error: "Invalid stream mode." });
    }

    const headers = { Accept: "*/*" };
    if (req.headers.range) headers.Range = req.headers.range;
    const fetched = await fetchAllowedTarget(target, headers, base);
    const upstream = fetched.response;
    target = fetched.url;
    const type = upstream.headers.get("content-type") || "";
    const pathname = target.pathname.toLowerCase();

    if (upstream.ok && (pathname.endsWith(".m3u8") || type.includes("mpegurl") || type.includes("vnd.apple"))) {
      let playlist = await upstream.text();
      const rewrite = (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (_all, uri) => {
            const absolute = new URL(uri, target).href;
            return `URI="${streamProxyUrl(absolute)}"`;
          });
        }
        const absolute = new URL(trimmed, target).href;
        return streamProxyUrl(absolute);
      };
      playlist = playlist.split(/\r?\n/).map(rewrite).join("\n");
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store");
      return res.end(playlist);
    }

    return await pipeUpstream(req, res, upstream);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected provider error.";
    if (message === "Enter your IPTV server URL.") {
      return res.status(503).json({ error: "AGYASHtv provider is not configured yet. Please contact support." });
    }
    if (message === "XTREAM_SESSION_SECRET is not configured.") {
      return res.status(503).json({ error: "Web sessions are not configured. Add XTREAM_SESSION_SECRET in Vercel." });
    }
    return res.status(500).json({ error: "Unable to contact your IPTV provider. Check its configuration and try again." });
  }
};
