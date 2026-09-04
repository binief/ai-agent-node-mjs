import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_DIR = path.join(os.homedir(), ".aiterm");
const MCP_PATH = path.join(DATA_DIR, "mcp.json");

// Create test mcp.json with SSE configuration
const mcpConfig = {
  "mcpServers": {
    "web-search": {
      "type": "sse",
      "url": "http://140.245.244.161:3001/sse"
    }
  }
};

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MCP_PATH, JSON.stringify(mcpConfig, null, 2));
  console.log("✓ Created MCP config at:", MCP_PATH);
  console.log("✓ Content:");
  console.log(JSON.stringify(mcpConfig, null, 2));
} catch (e) {
  console.error("✗ Error:", e.message);
}
