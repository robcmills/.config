import type { AgentsConfig } from "./src/types.ts";

export default {
  sort: {
    // Reorder these entries to choose primary, secondary, and later sorts.
    // Available: lastModified, project, status, name, provider, model, key.
    // lastModified sorts newest-first; all others use their configured order
    // or ascending text order.
    by: ["lastModified", "project", "status", "name"],
    projectOrder: [
      "openspace*",
      // Add remaining projects here in the desired order.
    ],
    statusOrder: [
      "waiting",
      "interrupting",
      "working",
      "monitoring",
      "starting",
      "ready",
    ],
  },
} satisfies AgentsConfig;
