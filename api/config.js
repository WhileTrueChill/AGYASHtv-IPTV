module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(410).json({ error: "Enter your provider URL on the AGYASHtv login screen." });
};
