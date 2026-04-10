require("./env");
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const routes = require("./routes");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// API routes
app.use("/api", routes);

// Serve frontend in production
const frontendDist = path.join(__dirname, "..", "frontend", "dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get("*", (req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

const server = app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n[server] Port ${PORT} is already in use.\n` +
        `Another rrweb-video-converter process is likely still running.\n` +
        `Find and stop it:\n` +
        `  lsof -i :${PORT}         # find the PID\n` +
        `  kill <pid>               # or: pkill -f "node server"\n`
    );
  } else {
    console.error("[server] Listen error:", err);
  }
  process.exit(1);
});
