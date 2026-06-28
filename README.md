# open-automations

Deterministic automation control plane and daemon for Hasna open-source apps.

`open-automations` is the real automation product surface. It owns automation
specs, trigger materialization, deterministic run/action queue state, replay
requests, daemon leases, and release-grade audit boundaries. It uses
`@hasna/actions` as the action contract layer and can hand deterministic action
execution to runtime providers without owning agent workflow invocation.

## Package

```sh
bun add @hasna/automations @hasna/actions
```

```ts
import { AutomationsStore, exampleAutomationSpec } from "@hasna/automations";

const store = new AutomationsStore();
store.createAutomation(exampleAutomationSpec());
console.log(store.status());
store.close();
```

## CLI

```sh
automations --help
automations --json status
automations --json spec example
automations --json validate automation.json
automations --json create automation.json
automations --json list
automations --json simulate automation.json --persist --event-json '{"id":"evt_1","source":"open-events","type":"ticket.created","data":{"priority":"critical"}}'
automations --json queue claim --runner worker-1
automations --json queue fail <action-id> --code UPSTREAM_500 --message "upstream failed"
automations --json dlq list
automations --json dlq replay <action-id>
automations --json webhooks create tickets.escalate-critical --id tickets --path /webhooks/tickets --source open-events --type ticket.created --data-path data --dedupe-key-header X-Hasna-Event-Id --secret-ref secret://automations/webhooks/tickets
automations --json webhooks event tickets --body-json '{"data":{"priority":"critical"}}' --header X-Hasna-Event-Id:evt_1
automations --json webhooks test tickets --body-json '{"data":{"priority":"critical"}}' --header X-Hasna-Event-Id:evt_1
automations --json runtimes
automations-daemon --json status
automations-daemon --json run
automations-daemon --json run --once
automations-daemon --json serve --host 127.0.0.1 --port 7391
```

The default data root is `~/.hasna/automations`. Override it with
`HASNA_AUTOMATIONS_DIR` or `AUTOMATIONS_DATA_DIR`.

`automations-daemon run` stays alive and maintains the local daemon lease until
it receives `SIGINT` or `SIGTERM`. Use `--once` for smoke checks and tests.

## Boundaries

- `open-actions` defines portable action manifests and invocation contracts.
- `open-events` is trigger ingress.
- `open-automations` materializes triggers into durable automation runs and
  queued deterministic action work.
- `open-loops` owns agent workflow invocation, admission, and workflow run
  artifacts. It can consume explicit event envelopes from OpenAutomations, but
  it is not the automation product.

## Runtime Model

The local store enforces idempotent event-to-run materialization and idempotent
run-step queue rows. Queue workers claim available actions with a lease, mark
them succeeded, retryable, or dead, and can replay dead actions through the DLQ
surface. Event ingestion accepts OpenEvents-compatible envelopes structurally,
so the OpenEvents package remains the trigger ingress boundary.

## Integration Contracts

OpenEvents deliveries are input, not durable automation state. OpenAutomations
uses `event.dedupeKey` first and falls back to `event.id` when building
event-to-run and event-to-action idempotency keys. Replaying the same event
through OpenEvents therefore returns the existing run/action rows unless the
operator creates an explicit replay request through OpenAutomations.

OpenLoops is an optional runtime binding for deterministic OpenAutomations
actions, not the scheduler or control plane for automations. A runtime worker
claims queued deterministic actions with:

```sh
automations queue claim --runner open-loops:<worker-id>
```

It must complete or fail the same action with the same runner id before the
lease expires:

```sh
automations queue complete <action-id> --runner open-loops:<worker-id>
automations queue fail <action-id> --runner open-loops:<worker-id> --code <code> --message <message>
```

The queue enforces runner ownership and live leases for completion/failure, so
stale workers cannot finalize reclaimed actions.

Webhook ingress uses the same materialization path. The daemon accepts `POST`
requests on registered webhook paths, verifies HMAC SHA-256 signatures over the
exact raw request bytes when a route has `secretRef`, normalizes the request
into an event envelope, and then calls the durable materializer. It never stores
raw webhook secrets, raw signatures, request headers, or raw payload blobs by
default; route metadata stores secret references and body hashes only.

At runtime the daemon resolves signed route secrets from route-scoped
environment variables:

```sh
HASNA_AUTOMATIONS_WEBHOOK_SECRET_<ROUTE_ID>
AUTOMATIONS_WEBHOOK_SECRET_<ROUTE_ID>
HASNA_AUTOMATIONS_SECRET_<SECRET_REF_WITHOUT_SECRET_SCHEME>
```

For explicit OpenLoops event workflow routing, export only the normalized event
envelope and pipe it into OpenLoops:

```bash
automations --json webhooks event tickets \
  --body-json '{"data":{"priority":"critical"}}' \
  --header X-Hasna-Event-Id:evt_1 \
  | loops --json events handle generic
```

`webhooks event` and `webhooks test` are local operator commands. They do not
verify HMAC signatures or accept network requests; use `automations-daemon serve`
for signed ingress.

This event-envelope handoff is operator opt-in. OpenAutomations still owns
automation specs, trigger materialization, deterministic action queue state,
approvals, DLQ, and replay. OpenLoops owns agent workflow invocation, admission,
and `.hasna/loops/runs` artifacts when `loops events handle generic` is used.
OpenAutomations never owns task, PR, review, or agent workflow queues.
