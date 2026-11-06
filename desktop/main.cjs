const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const xtreamHandler = require("./api/xtream");

let server;
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const web = express();
    process.env.AGYASHTV_LOCAL_DESKTOP = "1";
    process.env.XTREAM_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
    web.disable("x-powered-by");
    web.use(express.json({ limit: "1mb" }));
    web.all("/api/xtream", (req, res) => Promise.resolve(xtreamHandler(req, res)).catch((error) => {
      if (!res.headersSent) res.status(500).json({ error: "AGYASHtv local API error." });
      else res.destroy(error);
    }));
    web.use(express.static(path.join(__dirname, "web"), { index: "index.html", etag: true }));
    server = web.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not start AGYASHtv local server."));
      resolve(`http://127.0.0.1:${address.port}`);
    });
    server.on("error", reject);
  });
}
async function createWindow() {
  const localUrl = await startLocalServer();
  const window = new BrowserWindow({
    width: 1366, height: 860, minWidth: 900, minHeight: 600,
    show: false, autoHideMenuBar: true, backgroundColor: "#08090D", title: "AGYASHtv",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
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
  createWindow().catch((error) => {
    const { dialog } = require("electron");
    dialog.showErrorBox("AGYASHtv could not start", error.message || "Please reinstall AGYASHtv.");
    app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("before-quit", () => { if (server) server.close(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
