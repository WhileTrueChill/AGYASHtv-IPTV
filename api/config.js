module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const sessionSecret = String(process.env.XTREAM_SESSION_SECRET || "");
  const webSessionsConfigured = Buffer.byteLength(sessionSecret, "utf8") >= 32;

  return res.status(200).json({
    ok: true,
    service: "AGYASHtv IPTV API",
    providerUrlRequired: true,
    webSessionsConfigured,
  });
};
