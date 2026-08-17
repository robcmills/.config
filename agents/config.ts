import type { AgentsConfig } from "./src/types.ts";

export default {
  sort: {
    by: ["project", "status", "name"],
    projectOrder: [
      "openspace*",
      // Add remaining projects here in the desired order.
    ],
    statusOrder: [
      "waiting",
      "interrupting",
      "working",
      "starting",
      "ready",
    ],
  },
} satisfies AgentsConfig;
