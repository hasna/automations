import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationsStore, exampleAutomationSpec, validateAutomationSpec } from "./store.js";

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hasna-automations-store-"));
  process.env.HASNA_AUTOMATIONS_DIR = dataDir;
});

afterEach(() => {
  delete process.env.HASNA_AUTOMATIONS_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("AutomationsStore", () => {
  test("initializes local SQLite store and reports empty status", () => {
    const store = new AutomationsStore();
    try {
      const status = store.status();
      expect(status).toMatchObject({
        service: "automations",
        schemaVersion: "1.0",
        dataDir,
        counts: {
          automations: 0,
          runs: 0,
          queuedActions: 0,
          deadActions: 0,
          replayRequests: 0,
          webhookRoutes: 0,
        },
        daemon: { active: false },
      });
      expect(status.dbPath).toContain("automations.db");
    } finally {
      store.close();
    }
  });

  test("persists automation specs, materialized runs, queued actions, replay requests, and daemon heartbeat", () => {
    const store = new AutomationsStore();
    try {
      const spec = store.createAutomation(exampleAutomationSpec());
      expect(spec.id).toBe("tickets.escalate-critical");

      const run = store.createRun({
        id: "run_1",
        automationId: spec.id,
        trigger: { kind: "event", source: "open-events", type: "ticket.created" },
        triggerEventId: "evt_1",
        idempotencyKey: "evt_1:tickets.escalate-critical",
      });
      expect(run.status).toBe("materialized");
      const duplicateRun = store.createRun({
        id: "run_duplicate",
        automationId: spec.id,
        trigger: { kind: "event", source: "open-events", type: "ticket.created" },
        triggerEventId: "evt_1",
        idempotencyKey: "evt_1:tickets.escalate-critical",
      });
      expect(duplicateRun.id).toBe(run.id);

      const action = store.enqueueAction({
        id: "act_1",
        automationRunId: run.id,
        stepId: "create-escalation-task",
        actionId: "todos.create",
        availableAt: "2026-06-28T00:00:00.000Z",
        invocation: {
          id: "inv_1",
          actionId: "todos.create",
          manifestVersion: "1.0.0",
          input: { title: "Escalate critical ticket" },
          requestedAt: "2026-06-28T00:00:00.000Z",
          idempotencyKey: "evt_1:act_1",
        },
      });
      expect(action.status).toBe("queued");
      expect(action.idempotencyKey).toBe("evt_1:act_1");
      const duplicateAction = store.enqueueAction({
        id: "act_duplicate",
        automationRunId: run.id,
        stepId: "create-escalation-task",
        actionId: "todos.create",
        invocation: {
          id: "inv_duplicate",
          actionId: "todos.create",
          manifestVersion: "1.0.0",
          input: { title: "Escalate critical ticket duplicate" },
          requestedAt: "2026-06-28T00:00:00.000Z",
        },
      });
      expect(duplicateAction.id).toBe(action.id);

      const replay = store.createReplayRequest({
        id: "replay_1",
        sourceRunId: run.id,
        mode: "failed-actions",
        reason: "manual test",
      });
      expect(replay.mode).toBe("failed-actions");
      expect(() => store.createReplayRequest({
        sourceRunId: "missing_run",
        mode: "entire-run",
      })).toThrow("automation run not found");

      const lease = store.heartbeatDaemon({ leaseId: "daemon:test", now: new Date("2026-06-28T00:00:00.000Z") });
      expect(lease.id).toBe("daemon:test");
      expect((store.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);

      const claimed = store.claimNextAction({ runnerId: "tester", now: "2026-06-28T00:00:01.000Z" });
      expect(claimed).toMatchObject({ id: action.id, status: "claimed", claimedBy: "tester" });

      const retrying = store.failAction({
        actionId: action.id,
        runnerId: "tester",
        now: "2026-06-28T00:00:02.000Z",
        retryBackoffMs: 0,
        error: { code: "UPSTREAM_500", message: "upstream failed", retryable: true },
      });
      expect(retrying).toMatchObject({ status: "retrying", attempt: 1 });

      const secondClaim = store.claimNextAction({ runnerId: "tester", now: "2026-06-28T00:00:03.000Z" });
      expect(secondClaim).toMatchObject({ id: action.id, status: "claimed" });
      store.failAction({
        actionId: action.id,
        runnerId: "tester",
        now: "2026-06-28T00:00:04.000Z",
        retryBackoffMs: 0,
        error: { code: "UPSTREAM_500", message: "upstream failed", retryable: true },
      });
      const thirdClaim = store.claimNextAction({ runnerId: "tester", now: "2026-06-28T00:00:05.000Z" });
      expect(thirdClaim).toMatchObject({ id: action.id, status: "claimed" });
      const dead = store.failAction({
        actionId: action.id,
        runnerId: "tester",
        now: "2026-06-28T00:00:06.000Z",
        error: { code: "UPSTREAM_500", message: "upstream failed", retryable: true },
      });
      expect(dead).toMatchObject({ status: "dead", attempt: 3, deadLetter: { replayable: true } });
      expect(store.listDeadActions()).toHaveLength(1);

      const requeued = store.requeueDeadAction(action.id, { now: "2026-06-28T00:00:07.000Z", requestedBy: "tester" });
      expect(requeued).toMatchObject({ status: "queued", attempt: 0 });
      const completedClaim = store.claimNextAction({ runnerId: "tester", now: "2026-06-28T00:00:08.000Z" });
      expect(completedClaim).toMatchObject({ id: action.id, status: "claimed" });
      const completed = store.completeAction({
        actionId: action.id,
        runnerId: "tester",
        now: "2026-06-28T00:00:09.000Z",
        result: { summary: "created task", output: { taskId: "task_1" } },
      });
      expect(completed).toMatchObject({ status: "succeeded", result: { summary: "created task" } });
      expect(() => store.failAction({
        actionId: action.id,
        runnerId: "tester",
        now: "2026-06-28T00:00:10.000Z",
        error: { code: "TOO_LATE", message: "already done" },
      })).toThrow("cannot fail terminal queued action");

      expect(store.status(new Date("2026-06-28T00:00:01.000Z"))).toMatchObject({
        counts: {
          automations: 1,
          runs: 1,
          queuedActions: 1,
          deadActions: 0,
          replayRequests: 2,
          webhookRoutes: 0,
        },
        daemon: { active: true, leaseId: "daemon:test" },
      });
    } finally {
      store.close();
    }
  });

  test("materializes matching events into idempotent runs and queued actions", () => {
    const store = new AutomationsStore();
    try {
      store.createAutomation(exampleAutomationSpec());
      const materialized = store.materializeEvent({
        id: "evt_critical",
        dedupeKey: "ticket:critical:1",
        source: "open-events",
        type: "ticket.created",
        time: "2026-06-28T00:00:00.000Z",
        data: { priority: "critical" },
      });
      expect(materialized).toHaveLength(1);
      expect(materialized[0]?.run.idempotencyKey).toBe("tickets.escalate-critical:ticket:critical:1");
      expect(materialized[0]?.actions[0]?.idempotencyKey).toBe("tickets.escalate-critical:ticket:critical:1:create-escalation-task");

      const duplicate = store.materializeEvent({
        id: "evt_duplicate_id",
        dedupeKey: "ticket:critical:1",
        source: "open-events",
        type: "ticket.created",
        time: "2026-06-28T00:00:00.000Z",
        data: { priority: "critical" },
      });
      expect(duplicate[0]?.run.id).toBe(materialized[0]?.run.id);
      expect(store.listRuns()).toHaveLength(1);
      expect(store.listQueuedActions()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("persists webhook routes without raw secrets and materializes scoped webhook events idempotently", () => {
    const store = new AutomationsStore();
    try {
      store.createAutomation({
        schemaVersion: "1.0",
        id: "webhook-scope",
        name: "Webhook scope",
        version: "1.0.0",
        triggers: [{ kind: "webhook", source: "github", type: "push", filter: { branch: "main" } }],
        actions: [
          { id: "enqueue", actionId: "actions.enqueue" },
        ],
      });
      store.createAutomation({
        schemaVersion: "1.0",
        id: "forged-target",
        name: "Forged target",
        version: "1.0.0",
        triggers: [{ kind: "event", source: "evil", type: "push" }],
        actions: [
          { id: "forged", actionId: "actions.forged" },
        ],
      });
      const forgedWebhookEvent = store.materializeEvent({
        id: "evt_forged_webhook",
        source: "github",
        type: "push",
        data: { branch: "main" },
        metadata: {
          webhook: {
            routeId: "github-main",
            automationId: "webhook-scope",
          },
        },
      });
      expect(forgedWebhookEvent).toHaveLength(0);

      const route = store.createWebhookRoute({
        id: "github-main",
        automationId: "webhook-scope",
        path: "/webhooks/github/main",
        signature: {
          algorithm: "hmac-sha256",
          secretRef: "secret://automations/webhooks/github-main",
          header: "X-Hub-Signature-256",
          prefix: "sha256=",
        },
        mapping: {
          source: "github",
          type: "push",
          dataPath: "payload",
          dedupeKeyHeader: "X-GitHub-Delivery",
          metadata: { provider: "github" },
        },
      });
      expect(route).toMatchObject({
        id: "github-main",
        automationId: "webhook-scope",
        status: "active",
        signature: { secretRef: "secret://automations/webhooks/github-main" },
      });
      const signatureJson = (store.db.query("SELECT signature_json FROM webhook_routes WHERE id = 'github-main'").get() as { signature_json: string }).signature_json;
      expect(signatureJson).not.toContain("shared-secret");
      expect(signatureJson).not.toContain("rawSignature");
      const forgedWithRouteOption = store.materializeEvent({
        id: "evt_forged_route_option",
        source: "github",
        type: "push",
        data: { branch: "main" },
        metadata: {
          webhook: {
            routeId: "github-main",
            automationId: "webhook-scope",
          },
        },
      }, { webhookRoute: route } as never);
      expect(forgedWithRouteOption).toHaveLength(0);
      expect(() => store.createWebhookRoute({
        id: "bad-signature",
        automationId: "webhook-scope",
        mapping: { source: "github", type: "push" },
        signature: {
          algorithm: "hmac-sha256",
          secretRef: "secret://automations/webhooks/bad-signature",
          secret: "shared-secret",
        } as never,
      })).toThrow("unsupported webhook signature field: secret");

      const rawBody = JSON.stringify({
        id: "body-id-that-should-not-win",
        source: "evil",
        type: "push",
        payload: {
          branch: "main",
          repository: "open-automations",
        },
      });
      const materialized = store.materializeWebhookRequest({
        route,
        rawBody,
        headers: {
          "X-GitHub-Delivery": "delivery-1",
          "X-Hub-Signature-256": "sha256=redacted",
        },
        receivedAt: "2026-06-28T00:00:00.000Z",
      });

      expect(materialized.event).toMatchObject({
        source: "github",
        type: "push",
        dedupeKey: "delivery-1",
        data: {
          branch: "main",
          repository: "open-automations",
        },
        metadata: {
          provider: "github",
          webhook: {
            routeId: "github-main",
            automationId: "webhook-scope",
            path: "/webhooks/github/main",
            signatureConfigured: true,
          },
        },
      });
      expect(JSON.stringify(materialized.event.metadata)).not.toContain("redacted");
      expect(JSON.stringify(materialized.event.metadata)).not.toContain(rawBody);
      expect(materialized.materialized).toHaveLength(1);
      expect(materialized.materialized[0]?.automation.id).toBe("webhook-scope");
      expect(materialized.materialized[0]?.actions[0]?.idempotencyKey).toBe("webhook-scope:delivery-1:enqueue");

      const duplicate = store.materializeWebhookRequest({
        route,
        rawBody,
        headers: { "X-GitHub-Delivery": "delivery-1" },
        receivedAt: "2026-06-28T00:00:01.000Z",
      });
      expect(duplicate.materialized[0]?.run.id).toBe(materialized.materialized[0]?.run.id);
      expect(store.listRuns()).toHaveLength(1);
      expect(store.listQueuedActions()).toHaveLength(1);
      expect(store.status()).toMatchObject({ counts: { webhookRoutes: 1 } });
    } finally {
      store.close();
    }
  });

  test("normalizes webhook requests with deterministic body-hash dedupe and no raw data by default", () => {
    const store = new AutomationsStore();
    try {
      store.createAutomation({
        schemaVersion: "1.0",
        id: "webhook-default-data",
        name: "Webhook default data",
        version: "1.0.0",
        triggers: [{ kind: "event", source: "stripe", type: "invoice.created" }],
        actions: [
          { id: "record", actionId: "actions.record" },
        ],
      });
      const route = store.createWebhookRoute({
        id: "stripe-invoices",
        automationId: "webhook-default-data",
        path: "/webhooks/stripe/invoices",
        mapping: {
          source: "stripe",
          type: "invoice.created",
          idPath: "id",
        },
      });
      const result = store.materializeWebhookRequest({
        route,
        rawBody: JSON.stringify({ id: "evt_invoice_1", amount: 1000 }),
        receivedAt: "2026-06-28T00:00:00.000Z",
      });
      expect(result.event).toMatchObject({
        id: "evt_invoice_1",
        source: "stripe",
        type: "invoice.created",
        data: {},
        dedupeKey: "evt_invoice_1",
      });
      expect(result.event.metadata?.webhook).toMatchObject({
        routeId: "stripe-invoices",
        rawBodySha256: expect.any(String),
      });
    } finally {
      store.close();
    }
  });

  test("respects dependencies and approval gates during claims", () => {
    const store = new AutomationsStore();
    try {
      store.createAutomation({
        schemaVersion: "1.0",
        id: "dependency-test",
        name: "Dependency test",
        version: "1.0.0",
        triggers: [{ kind: "event", source: "open-events", type: "dep.test" }],
        actions: [
          { id: "first", actionId: "actions.first" },
          { id: "second", actionId: "actions.second", dependsOn: ["first"] },
          {
            id: "approved",
            actionId: "actions.approved",
            approval: { mode: "manual", requiresApproval: true },
          },
        ],
      });
      store.materializeEvent({
        id: "evt_dep",
        source: "open-events",
        type: "dep.test",
        time: "2026-06-28T00:00:00.000Z",
        data: {},
      });

      const first = store.claimNextAction({ runnerId: "dep", now: "2026-06-28T00:00:01.000Z" });
      expect(first?.stepId).toBe("first");
      store.completeAction({
        actionId: first!.id,
        runnerId: "dep",
        now: "2026-06-28T00:00:02.000Z",
      });

      const second = store.claimNextAction({ runnerId: "dep", now: "2026-06-28T00:00:03.000Z" });
      expect(second?.stepId).toBe("second");
      store.completeAction({
        actionId: second!.id,
        runnerId: "dep",
        now: "2026-06-28T00:00:04.000Z",
      });

      expect(store.claimNextAction({ runnerId: "dep", now: "2026-06-28T00:00:05.000Z" })).toBeUndefined();
      const approvalAction = store.listQueuedActions().find((action) => action.stepId === "approved");
      expect(approvalAction).toMatchObject({
        status: "waiting_approval",
        approvalGate: {
          blockedUntilApproved: true,
          decision: { status: "pending", requestedAt: "2026-06-28T00:00:00.000Z" },
        },
      });
      store.approveAction(approvalAction!.id, { now: "2026-06-28T00:00:06.000Z", decidedBy: "tester" });
      expect(() => store.approveAction(approvalAction!.id, { now: "2026-06-28T00:00:06.500Z" })).toThrow("approval decision is not pending");
      expect(() => store.rejectAction(approvalAction!.id, { now: "2026-06-28T00:00:06.750Z" })).toThrow("approval decision is not pending");
      const approved = store.claimNextAction({ runnerId: "dep", now: "2026-06-28T00:00:07.000Z" });
      expect(approved?.stepId).toBe("approved");
      expect(() => store.rejectAction(approved!.id, { now: "2026-06-28T00:00:08.000Z" })).toThrow("claimed queued action");
    } finally {
      store.close();
    }
  });

  test("keeps approval rejections non-replayable and terminal approval transitions guarded", () => {
    const store = new AutomationsStore();
    try {
      store.createAutomation({
        schemaVersion: "1.0",
        id: "approval-rejection-test",
        name: "Approval rejection test",
        version: "1.0.0",
        triggers: [{ kind: "event", source: "open-events", type: "approval.test" }],
        actions: [
          { id: "needs-approval", actionId: "actions.external-write", approval: { mode: "manual", requiresApproval: true } },
        ],
      });
      store.materializeEvent({
        id: "evt_approval_reject",
        source: "open-events",
        type: "approval.test",
        time: "2026-06-28T00:00:00.000Z",
        data: {},
      });

      expect(store.claimNextAction({ runnerId: "approval", now: "2026-06-28T00:00:01.000Z" })).toBeUndefined();
      const waiting = store.listQueuedActions().find((action) => action.stepId === "needs-approval")!;
      expect(waiting).toMatchObject({ status: "waiting_approval", approvalGate: { decision: { status: "pending" } } });

      const rejected = store.rejectAction(waiting.id, {
        now: "2026-06-28T00:00:02.000Z",
        decidedBy: "tester",
        reason: "not safe",
      });
      expect(rejected).toMatchObject({ status: "dead", deadLetter: { replayable: false } });
      expect(() => store.requeueDeadAction(rejected.id, { now: "2026-06-28T00:00:03.000Z" })).toThrow("not replayable");
      expect(() => store.approveAction(rejected.id, { now: "2026-06-28T00:00:04.000Z" })).toThrow("terminal queued action");
    } finally {
      store.close();
    }
  });

  test("continues scanning past dependency-blocked actions when claiming", () => {
    const store = new AutomationsStore();
    try {
      const blockedActions = Array.from({ length: 25 }, (_, index) => ({
        id: `blocked-${String(index).padStart(2, "0")}`,
        actionId: "actions.blocked",
        dependsOn: ["missing-success"],
      }));
      store.createAutomation({
        schemaVersion: "1.0",
        id: "claim-scan-test",
        name: "Claim scan test",
        version: "1.0.0",
        triggers: [{ kind: "event", source: "open-events", type: "claim.scan" }],
        actions: [
          { id: "missing-success", actionId: "actions.missing" },
          ...blockedActions,
          { id: "ready-after-blocked", actionId: "actions.ready" },
        ],
      });
      const run = store.createRun({
        id: "run_claim_scan",
        automationId: "claim-scan-test",
        trigger: { kind: "manual" },
      });
      for (const step of blockedActions) {
        store.enqueueAction({
          id: step.id,
          automationRunId: run.id,
          stepId: step.id,
          actionId: step.actionId,
          availableAt: "2026-06-28T00:00:00.000Z",
          invocation: {
            id: `inv_${step.id}`,
            actionId: step.actionId,
            manifestVersion: "1.0.0",
            input: {},
            requestedAt: "2026-06-28T00:00:00.000Z",
          },
        });
      }
      store.enqueueAction({
        id: "ready-after-blocked",
        automationRunId: run.id,
        stepId: "ready-after-blocked",
        actionId: "actions.ready",
        availableAt: "2026-06-28T00:00:00.000Z",
        invocation: {
          id: "inv_ready_after_blocked",
          actionId: "actions.ready",
          manifestVersion: "1.0.0",
          input: {},
          requestedAt: "2026-06-28T00:00:00.000Z",
        },
      });

      const claimed = store.claimNextAction({ runnerId: "scanner", now: "2026-06-28T00:00:01.000Z" });
      expect(claimed).toMatchObject({ id: "ready-after-blocked", stepId: "ready-after-blocked", status: "claimed" });
    } finally {
      store.close();
    }
  });

  test("does not let stale runners finalize reclaimed actions", () => {
    const store = new AutomationsStore();
    try {
      store.createAutomation(exampleAutomationSpec());
      const run = store.createRun({
        id: "run_stale_claim",
        automationId: "tickets.escalate-critical",
        trigger: { kind: "manual" },
      });
      const action = store.enqueueAction({
        id: "act_stale_claim",
        automationRunId: run.id,
        stepId: "create-escalation-task",
        actionId: "todos.create",
        availableAt: "2026-06-28T00:00:00.000Z",
        invocation: {
          id: "inv_stale_claim",
          actionId: "todos.create",
          manifestVersion: "1.0.0",
          input: {},
          requestedAt: "2026-06-28T00:00:00.000Z",
        },
      });
      const claimed = store.claimNextAction({
        runnerId: "runner-a",
        leaseMs: 30000,
        now: "2026-06-28T00:00:01.000Z",
      });
      expect(claimed).toMatchObject({ id: action.id, status: "claimed", claimedBy: "runner-a" });

      const originalRequire = store.requireQueuedAction.bind(store);
      const stealClaimDuringPrecheck = (): void => {
        store.db.query(`
          UPDATE automation_actions
          SET claimed_by = 'runner-b',
              claimed_at = '2026-06-28T00:00:02.000Z',
              lease_expires_at = '2026-06-28T00:00:32.000Z',
              updated_at = '2026-06-28T00:00:02.000Z'
          WHERE id = $id
        `).run({ $id: action.id });
      };
      const injectClaimSteal = (): void => {
        let injected = false;
        store.requireQueuedAction = ((id: string) => {
          const snapshot = originalRequire(id);
          if (!injected && id === action.id) {
            injected = true;
            stealClaimDuringPrecheck();
          }
          return snapshot;
        }) as AutomationsStore["requireQueuedAction"];
      };

      try {
        injectClaimSteal();
        expect(() => store.completeAction({
          actionId: action.id,
          runnerId: "runner-a",
          now: "2026-06-28T00:00:03.000Z",
        })).toThrow("lease is no longer active");

        store.requireQueuedAction = originalRequire;
        expect(originalRequire(action.id)).toMatchObject({ status: "claimed", claimedBy: "runner-a", attempt: 0 });

        injectClaimSteal();
        expect(() => store.failAction({
          actionId: action.id,
          runnerId: "runner-a",
          now: "2026-06-28T00:00:04.000Z",
          error: { code: "STALE", message: "stale runner" },
        })).toThrow("lease is no longer active");
      } finally {
        store.requireQueuedAction = originalRequire;
      }
      expect(store.requireQueuedAction(action.id)).toMatchObject({ status: "claimed", claimedBy: "runner-a", attempt: 0 });
    } finally {
      store.close();
    }
  });

  test("validates spec shape before persistence", () => {
    const duplicate = {
      ...exampleAutomationSpec(),
      actions: [
        { id: "same", actionId: "one" },
        { id: "same", actionId: "two" },
      ],
    };
    expect(() => validateAutomationSpec(duplicate)).toThrow("duplicate automation action step id");

    const missingDependency = {
      ...exampleAutomationSpec(),
      actions: [
        { id: "first", actionId: "one", dependsOn: ["missing"] },
      ],
    };
    expect(() => validateAutomationSpec(missingDependency)).toThrow("depends on unknown step");

    const invalidTrigger = {
      ...exampleAutomationSpec(),
      triggers: [{ kind: "invalid" }],
    };
    expect(() => validateAutomationSpec(invalidTrigger as never)).toThrow("unsupported automation trigger kind");

    const staticApprovalDecision = {
      ...exampleAutomationSpec(),
      actions: [
        {
          id: "dangerous",
          actionId: "dangerous.write",
          approvalGate: {
            requirement: { mode: "manual", requiresApproval: true },
            blockedUntilApproved: false,
            decision: {
              id: "preapproved",
              status: "approved",
              requestedAt: "2026-06-28T00:00:00.000Z",
              decidedAt: "2026-06-28T00:00:00.000Z",
            },
          },
        },
      ],
    };
    expect(() => validateAutomationSpec(staticApprovalDecision as never)).toThrow("approval gate templates cannot include decisions");
  });
});
