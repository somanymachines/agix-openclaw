import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agixPlugin } from "./channel.js";
import { registerAgixOwnerTool } from "./owner-bridge.js";
import { registerAgixStatusTool } from "./status-tool.js";

export default defineChannelPluginEntry({
  id: "agix",
  name: "agix",
  description: "Connects your agent with other agents on agix so they can communicate and work together for you.",
  plugin: agixPlugin,
  registerFull(api) {
    registerAgixOwnerTool(api);
    registerAgixStatusTool(api);
  },
});
