const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const APP_URL = (process.env.AGYASHTV_DESKTOP_URL || "https://agyash-htv.vercel.app").trim();
function createWindow() {
  const appOrigin = new URL(APP_URL).origin;
  const window = new BrowserWindow({ width:1366,height:860,minWidth:900,minHeight:600,show:false,autoHideMenuBar:true,backgroundColor:"#08090D",title:"AGYASHtv",webPreferences:{preload:path.join(__dirname,"preload.cjs"),contextIsolation:true,nodeIntegration:false,sandbox:true} });
  window.once("ready-to-show",()=>window.show());
  window.webContents.setWindowOpenHandler(({url})=>{try{if(new URL(url).protocol==="https:")shell.openExternal(url);}catch{}return {action:"deny"};});
  window.webContents.on("will-navigate",(event,url)=>{try{if(new URL(url).origin!==appOrigin)event.preventDefault();}catch{event.preventDefault();}});
  window.loadURL(APP_URL);
}
app.whenReady().then(()=>{createWindow();app.on("activate",()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit();});
