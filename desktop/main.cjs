const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const xtreamHandler = require("./api/xtream");

let server;
function startLocalServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const requestUrl = new URL(req.url || "/", base);
      req.query = Object.fromEntries(requestUrl.searchParams.entries());
      if (req.method === "POST" && requestUrl.pathname === "/api/xtream") {
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 1024 * 1024) {
              res.writeHead(413, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Request is too large." }));
              return;
            }
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          req.body = raw ? JSON.parse(raw) : {};
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request body." }));
          return;
        }
      }
      if (requestUrl.pathname === "/api/xtream") {
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (data) => {
          if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(data));
          return res;
        };
        try { await xtreamHandler(req, res); }
        catch (error) {
          console.error("[AGYASHtv local API]", error);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            const detail = error instanceof Error ? error.message : "Unexpected local API error.";
            res.end(JSON.stringify({ error: `AGYASHtv local API error: ${detail}` }));
          } else res.destroy(error);
        }
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return;
      }
      const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
      const file = path.resolve(__dirname, "web", relative || "index.html");
      const root = path.resolve(__dirname, "web");
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403); res.end("Forbidden"); return;
      }
      const fs = require("node:fs");
      fs.stat(file, (error, stat) => {
        const actual = !error && stat.isFile() ? file : path.join(root, "index.html");
        fs.readFile(actual, (readError, content) => {
          if (readError) { res.writeHead(404); res.end("AGYASHtv app files not found."); return; }
          const ext = path.extname(actual).toLowerCase();
          const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".woff2":"font/woff2" };
          res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control":"no-store" });
          if (req.method === "HEAD") res.end(); else res.end(content);
        });
      });
    });
    process.env.AGYASHTV_LOCAL_DESKTOP = "1";
    process.env.XTREAM_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.on("error", reject);
  });
}
async function createWindow() {
  const localUrl = await startLocalServer();
  const window = new BrowserWindow({
    width: 1366, height: 860, minWidth: 900, minHeight: 600,
    show: false, autoHideMenuBar: true, backgroundColor: "#08090D", title: "AGYASHtv",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).protocol === "https:") shell.openExternal(url); } catch {}
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    try { if (new URL(url).origin !== new URL(localUrl).origin) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  await window.loadURL(localUrl);
}
app.whenReady().then(() => {
  createWindow().catch((error) => { dialog.showErrorBox("AGYASHtv could not start", error.message || "Please reinstall AGYASHtv."); app.quit(); });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => { if (server) server.close(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
