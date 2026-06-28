import type { AutomationRuntimeBinding } from "../types.js";
import type { JsonObject } from "@hasna/actions";

export function createOpenLoopsRuntimeBinding(metadata: JsonObject = {}): AutomationRuntimeBinding {
  return {
    kind: "open-loops",
    name: "open-loops-runtime",
    description: "OpenLoops may claim queued deterministic OpenAutomations actions or consume explicitly exported event envelopes through opt-in handoff commands. Agent workflow invocation remains owned by OpenLoops.",
    handoff: "claim-queue",
    metadata: {
      queueClaim: {
        statusCommand: "automations status",
        claimCommand: "automations queue claim --runner open-loops:<worker-id>",
        completeCommand: "automations queue complete <action-id> --runner open-loops:<worker-id>",
        failCommand: "automations queue fail <action-id> --runner open-loops:<worker-id> --code <code> --message <message>",
      },
      eventEnvelope: {
        exportCommand: "automations webhooks event <route-id-or-path> --body-json <json>",
        openLoopsCommand: "loops events handle generic",
        pipeExample: "automations --json webhooks event <route> --body-json '<json>' | loops --json events handle generic",
        boundary: "Event-envelope handoff is explicit operator routing; OpenLoops owns agent workflow invocation, admission, and run artifacts, while OpenAutomations owns deterministic automation specs, materialization, action queues, approvals, DLQ, and replay.",
      },
      ...metadata,
    },
  };
}

export function listDefaultRuntimeBindings(): AutomationRuntimeBinding[] {
  return [
    createOpenLoopsRuntimeBinding(),
  ];
}
