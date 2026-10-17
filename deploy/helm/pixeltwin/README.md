# pixeltwin Helm chart

Deploys [pixeltwin](../../../README.md) to Kubernetes 1.30 or later.

## Install

The chart is not published to a chart repository yet; install it from a checkout:

```sh
helm install pixeltwin deploy/helm/pixeltwin -n pixeltwin --create-namespace \
  --set publicUrl=https://pixeltwin.example.com \
  --set ingress.enabled=true --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=pixeltwin.example.com' --set 'ingress.hosts[0].paths[0].path=/'
helm test pixeltwin -n pixeltwin
```

The install notes show how to create the first admin. In short:

```sh
TOKEN=$(kubectl -n pixeltwin get secret pixeltwin -o jsonpath='{.data.SETUP_TOKEN}' | base64 -d)
open "https://pixeltwin.example.com/ui/setup?token=$TOKEN"
```

The chart writes a random `SETUP_TOKEN` to its Secret (or uses `setupToken`, at least 16
characters), and keeps it across upgrades. Every replica accepts it. The server never logs a token
that comes from `SETUP_TOKEN`. Once a user exists the token is refused. With `existingSecret` and
no `SETUP_TOKEN` key in it, each pod makes up its own token and logs it
(`kubectl logs … | grep setupUrl`); only the pod that logged it accepts it.

`values.schema.json` checks the values before anything is rendered: types, a `publicUrl`, a
database for `postgres` mode, `smtp.from` with `smtp.url`, and more than one replica only with
`postgres`.

### `publicUrl` is required

Set it to the address people and CI use, for example `https://pixeltwin.example.com`. A path prefix
is allowed. The server needs it for three things:

- **Links**: the setup link, the CI snippets in the UI, invite and reset mails, `/llms.txt`, and the
  prefix of every UI link and redirect.
- **Cookies**: the session cookie gets the `Secure` flag when the URL is `https://`.
- **CSRF**: browser requests authenticated by cookie (any method except GET and HEAD) must send an
  `Origin` equal to this URL's origin, or they get `403 csrf_origin_mismatch`.

The server's default is `http://localhost:8080`. With that default, logging in through an Ingress
would seem to work, but every button and form in the UI would then fail. For this reason the
chart refuses to install without `publicUrl`. For a quick try with a port-forward, use
`--set publicUrl=http://localhost:8080` and
`kubectl port-forward svc/pixeltwin 8080:80`.

### TLS

With ingress-nginx and cert-manager:

```yaml
publicUrl: https://pixeltwin.example.com
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "120"
  hosts:
    - host: pixeltwin.example.com
      paths: [{ path: /, pathType: Prefix }]
  tls:
    - secretName: pixeltwin-tls
      hosts: [pixeltwin.example.com]
```

Setting `ingress.annotations` replaces the default map, so repeat the timeouts. The body size
annotation is added for you (see [Upload size](#upload-size)).

## The two storage modes

| | `storage: local` (default) | `storage: postgres` |
|---|---|---|
| Images | files on a PVC at `/data` | in the Postgres database (`stored_objects` table) |
| Database | SQLite on the PVC, or Postgres when `database.url` is set | Postgres, `database.url` required |
| Replicas | exactly 1 (`replicaCount` > 1 is refused) | any |
| Volume | PVC, ReadWriteOnce (`persistence.*`) | none (an emptyDir as the working dir) |
| Update strategy | `Recreate`: the old pod stops before the new one starts | `RollingUpdate`, maxSurge 1, maxUnavailable 0 |
| Backup | the PVC and, with Postgres, the database | one `pg_dump` (`backup.enabled`) |

`local` is for a single instance: the volume is ReadWriteOnce, and SQLite allows one writer. An
upgrade or a restart therefore has a few seconds of downtime. The PVC has
`helm.sh/resource-policy: keep`, so `helm uninstall` leaves your data. Delete the PVC yourself
when you mean to.

`postgres` keeps everything in the database (images, thumbnails, the webhook, code host and mail
outboxes), so pods hold no state. You can scale them, roll them or reschedule them freely. A
minimal Postgres for trying it out is in
[`deploy/examples/postgres.yaml`](../../examples/postgres.yaml). For production, use a managed
database or an operator. Every pod opens up to `database.poolMax` (20) connections, so keep
`(replicaCount + 1) × poolMax` (one extra pod during a rolling update) under the server's
`max_connections`.

```sh
kubectl -n pixeltwin create secret generic pixeltwin-db \
  --from-literal=DATABASE_URL='postgres://pixeltwin:…@db.internal:5432/pixeltwin' \
  --from-literal=SETUP_TOKEN="$(openssl rand -hex 20)" \
  --from-literal=SECRET_KEY="$(openssl rand -hex 32)" \
  --from-literal=SMTP_URL='smtp://pixeltwin:…@smtp.example.com:587'
helm install pixeltwin deploy/helm/pixeltwin -n pixeltwin \
  --set storage=postgres --set replicaCount=3 --set existingSecret=pixeltwin-db \
  --set smtp.from='pixeltwin <pixeltwin@example.com>' \
  --set publicUrl=https://pixeltwin.example.com
```

Images in Postgres grow the database at about the rate the files would grow on disk; each image is
stored once by its hash. Builds older than a project's retention period are deleted every hour,
together with the images nothing references any more.

### Several replicas

What makes `postgres` mode safe to scale, and what the [kind smoke test](#testing-the-chart)
checks on every CI run:

- **Migrations** run at startup, before the server listens, inside one transaction under Kysely's
  migration lock (a Postgres advisory lock). Pods that start together take turns: one applies the
  migrations, the others find nothing left. A pod killed mid-migration rolls back. Because the
  server only listens once migrations are done, no probe passes and no traffic arrives before
  then; the startup probe allows 10 minutes (`probes.startup`), so the liveness probe never kills
  a pod during a long migration.
- **Outboxes**: webhooks, GitHub/GitLab updates and mails wait in database tables. Each row is
  claimed with a lease, so one replica sends it. A replica that dies mid-send leaves a lease that
  runs out and the row is sent again (at least once: receivers dedupe on `X-Pixeltwin-Delivery`).
  The hourly retention job and the "new access request" admin mail are also once across replicas.
- **Rolling updates** surge one pod and keep every old one until the new one is ready
  (`maxUnavailable: 0`). The old pod is taken out of the Service, keeps serving for
  `shutdown.preStopSleepSeconds` while the endpoints update, then gets SIGTERM and lets requests in
  flight finish for up to `shutdown.graceSeconds`. `terminationGracePeriodSeconds` is derived from
  both (plus 10 s to close the outboxes and workers), so the kubelet never kills a draining pod.
  The SDKs retry the rare upload whose connection is closed anyway.
- **Spread**: with more than one replica the pods are spread over nodes as a preference
  (`topologySpread`; `topologySpread.zones=true` adds zones, for clusters whose nodes all have a
  `topology.kubernetes.io/zone` label: on nodes without it the scheduler ignores the spreading
  altogether), and a PodDisruptionBudget keeps all but one running during node drains.

## Values

The full list with comments is in [`values.yaml`](values.yaml).

| Value | Default | |
|---|---|---|
| `publicUrl` | (required) | see above |
| `storage` | `local` | `local` or `postgres` |
| `replicaCount` | `1` | more than 1 needs `postgres` |
| `database.url` | | `postgres://…`; written to the chart's Secret |
| `database.poolMax` | `20` | `DATABASE_POOL_MAX` per pod |
| `existingSecret` | | your own Secret with `DATABASE_URL`, `SETUP_TOKEN`, `SECRET_KEY` and/or `SMTP_URL` (key names in `existingSecretKeys`) |
| `setupToken` | generated, kept across upgrades | first-run setup token, ≥ 16 characters |
| `secretKey` | generated, kept across upgrades | `SECRET_KEY`, ≥ 32 characters: seals the GitHub/GitLab token, webhook secrets and queued mails |
| `smtp.url` | | `SMTP_URL`, `smtp://user:pass@host:587` or `smtps://…:465`; written to the chart's Secret |
| `smtp.from` | | `SMTP_FROM`, required with `smtp.url` |
| `outbound.blockPrivate` | **`true`** | `OUTBOUND_BLOCK_PRIVATE`; see below |
| `diffWorkers` | CPU limit − 1 | `DIFF_WORKERS`; from `resources.limits.cpu` (else `requests.cpu`), rounded up, at least 1 |
| `config.logLevel` | `info` | `LOG_LEVEL` |
| `config.diffTimeoutMs` | `30000` | `DIFF_TIMEOUT_MS` |
| `config.diffQueueMax` | `diffWorkers × 20` | `DIFF_QUEUE_MAX`: above it uploads get `503 server_busy` with `Retry-After`; `0` never refuses |
| `config.maxImageBytes` | `10485760` | `MAX_IMAGE_BYTES`; also sizes the Ingress body limit |
| `config.maxImagePixels` | `40000000` | `MAX_IMAGE_PIXELS` |
| `shutdown.graceSeconds` | `20` | `SHUTDOWN_GRACE_MS` ÷ 1000: how long requests in flight may finish after SIGTERM |
| `shutdown.preStopSleepSeconds` | `5` | lets the endpoints drop the pod before it gets SIGTERM |
| `shutdown.terminationGracePeriodSeconds` | preStop + grace + 10 | refused when not above preStop + grace |
| `extraEnv` / `extraEnvFrom` | | more variables; do not repeat one the chart sets |
| `resources` | requests 500m / 2Gi, limits 2 CPU / 2560Mi | |
| `persistence.size` / `storageClass` / `existingClaim` | `20Gi` / default / | `local` mode |
| `service.type` / `port` / `nodePort` | `ClusterIP` / `80` / | |
| `ingress.*` | disabled | `proxy-body-size` from `maxImageBytes`, 120 s timeouts for ingress-nginx |
| `metrics.enabled` / `port` | `false` / `9464` | Prometheus metrics on a port and Service of their own |
| `metrics.serviceMonitor.*` | disabled | for the Prometheus Operator |
| `probes.*` | startup (10 min), readiness, liveness on `/healthz` | |
| `podDisruptionBudget` | `maxUnavailable: 1` | only with more than one replica |
| `topologySpread.enabled` / `zones` | `true` / `false` | default spread over nodes (and zones); `topologySpreadConstraints` replaces it |
| `networkPolicy.*` | disabled | see below |
| `backup.*` | disabled | nightly `pg_dump` to a PVC, see [Backups](#backups) |
| `tests.enabled` | `true` | the `helm test` pod |

**`outbound.blockPrivate` defaults to `true` in the chart, `false` in the binary.** Webhook URLs
and GitHub/GitLab hosts are typed in by project maintainers. On a laptop or a VM, a private address
is usually your own chat server or GitHub Enterprise next door, so the binary allows them. Inside a
cluster, private addresses are the pod and Service networks: the Kubernetes API, the database,
every internal Service. A maintainer should not be able to make pixeltwin POST there, so the chart
refuses them. Link-local addresses (cloud metadata) are refused either way. Set
`outbound.blockPrivate=false` when webhooks or a self-hosted code host live on a private network
you trust.

**Resources.** Under heavy parallel uploads with 10 diff workers, one pod used about 1.5 to 2 GB
of RAM ([load testing](../../../docs/load-testing.md)). An idle pod uses about 130 MiB. With
fewer workers, a pod needs less memory. `diffWorkers` follows `resources.limits.cpu` (2 CPUs: 1
worker, 4 CPUs: 3). Without any CPU value the server would count the node's cores, which on a big
node means many workers and a lot of memory, so the chart passes the number explicitly.

<a id="upload-size"></a>**Upload size.** The server accepts a body of at most the image as base64
plus 1 MiB for the metadata and page elements: about 15 MB with the default 10 MiB
`MAX_IMAGE_BYTES`. ingress-nginx refuses bodies over 1 MB by default, so the chart sets
`nginx.ingress.kubernetes.io/proxy-body-size` to that limit, computed from
`config.maxImageBytes` (`15m` by default), unless you set the annotation yourself. Other ingress
controllers need an equivalent setting. Uploads wait for their diff, so the read timeout is raised
as well.

**Probes.** `/healthz` checks the database and the storage. The startup probe covers migrations.
The readiness probe takes a pod out of the Service while its database is unreachable. The liveness
probe allows two minutes (6 × 20 s) before it restarts the pod, because a restart does not fix the
database.

**Security.** The pod runs as uid/gid 65532, the distroless `nonroot` user, with a read-only root
filesystem, no capabilities, no privilege escalation, `RuntimeDefault` seccomp and no service
account token. `fsGroup: 65532` makes the PVC writable. `/data` and `/tmp` are the only writable
paths; in `postgres` mode nothing is written to `/data`.

**Metrics.** `metrics.enabled=true` sets `METRICS=1`: the server serves `GET /metrics` on
`metrics.port`, a second port with a Service of its own (`<release>-metrics`) that the Ingress
does not route. There is no auth on it; use `networkPolicy.metrics.from` to limit who scrapes. It
has `pixeltwin_http_requests_total` and `pixeltwin_http_request_duration_seconds` (by method,
route pattern and status), `pixeltwin_checks_total` (by result), `pixeltwin_builds_finalized_total`
(by verdict), `pixeltwin_diff_queue_depth`, `pixeltwin_diff_workers`, `pixeltwin_outbox_pending`
(webhooks, code host, mail) and `pixeltwin_database_up`. Counters are per pod; the outbox gauges are
read from the database and are the same on every pod, so use `max`, not `sum`.

### NetworkPolicy

Off by default: it needs a CNI that enforces NetworkPolicy, and a wrong egress rule silently
stops webhooks or mail. With `networkPolicy.enabled=true` the pixeltwin pods accept:

- the http port from `networkPolicy.ingress.from` (the `ingress-nginx` namespace by default) and
  from pods labelled `<release>-pixeltwin-client: "true"` (the `helm test` pod);
- the metrics port from `networkPolicy.metrics.from` (the `monitoring` namespace);

and may connect to:

- DNS on port 53;
- the database: `networkPolicy.egress.database.to` (peers) on `ports` (5432), e.g.
  `[{ podSelector: { matchLabels: { app: pixeltwin-postgres } } }]` or an `ipBlock`. **Set it**, or
  the pods cannot reach Postgres;
- the internet on 443 (GitHub, GitLab, webhooks), 465 and 587 (SMTP), private ranges excepted;
- anything in `networkPolicy.egress.extra`, e.g. an internal GitLab or SMTP relay.

## Upgrading

```sh
helm upgrade pixeltwin deploy/helm/pixeltwin -n pixeltwin --reset-then-reuse-values --set image.tag=<version>
```

Use `--reset-then-reuse-values` (Helm 3.14+), not `--reuse-values`: `--reuse-values` keeps only
the values of the last release and drops the defaults of values the new chart adds (`smtp`,
`outbound`, `shutdown`, …), which then fail to render.

Pods apply pending database migrations at startup. In `postgres` mode, several pods that start at
once take turns through the migrator's lock: one applies the migrations, and the others find
nothing left to do. During a rolling update, old pods keep serving against the migrated database
until they are replaced. Rolling the image back does not undo migrations, so take a backup before
an upgrade.

Changing `database.url`, `setupToken`, `secretKey` or `smtp.url` restarts the pods. Changes inside
an `existingSecret` do not restart them, so run `kubectl rollout restart deployment/pixeltwin`
yourself.

Switching an existing install between `local` and `postgres` does not move the images. Images
already on the PVC are not copied into the database.

### From chart 0.1.x to 0.2.0

- **`outbound.blockPrivate` is `true`.** Webhooks and GitHub/GitLab calls to private addresses
  (an in-cluster chat bot, GitHub Enterprise on 10.x) now fail with an error in the delivery log.
  Set `outbound.blockPrivate=false` to keep the old behaviour.
- **`replicaCount` > 1 with `storage: local` is refused** instead of silently ignored. Remove it or
  set it to 1.
- **`preStopSleepSeconds` and `terminationGracePeriodSeconds` moved under `shutdown`.** The old
  top-level values still work (the notes warn), but `terminationGracePeriodSeconds` is now
  derived: 35 s by default instead of 30 s. `SHUTDOWN_GRACE_MS` is now set from
  `shutdown.graceSeconds` (20 s, the server's default).
- **The Ingress body size is computed** from `config.maxImageBytes`: `15m` by default instead of the
  fixed `20m`. Uploads are accepted up to the same size as before (the server's own limit). If you
  set the annotation yourself, yours is kept.
- **`DIFF_WORKERS` is always set** from the CPU limit when `diffWorkers` is empty. With the default
  2-CPU limit it is 1, as before; without CPU values it is no longer the node's core count.
- **Readiness probes every 5 s** (was 10 s), and the startup probe allows 10 minutes (was 2).
- New, off by default: `smtp.*`, `metrics.*`, `networkPolicy.*`, `backup.*`. New and on: the
  topology spread for several replicas and the `helm test` pod.
- The pod template changes (new variables), so the upgrade rolls the pods once.

## Backups

- **`postgres` mode**: `pg_dump` covers everything: users, projects, builds, baselines and the
  image bytes. `backup.enabled=true` adds a CronJob (`backup.schedule`, nightly by default) that
  writes `pg_dump -Fc` files to a PVC of its own and keeps the last `backup.keep` (7). With a
  managed database or an operator, prefer their snapshots and point-in-time recovery and leave it
  off. To take one by hand:

  ```sh
  kubectl -n pixeltwin create job --from=cronjob/pixeltwin-backup pixeltwin-backup-now
  # or, with the example Postgres:
  kubectl -n pixeltwin exec pixeltwin-postgres-0 -- pg_dump -U pixeltwin -Fc pixeltwin > pixeltwin.dump
  ```

  Restore with `pg_restore --clean --no-owner -d "$DATABASE_URL" pixeltwin-….dump` while pixeltwin
  is scaled to 0.
- **`SECRET_KEY`**: integration tokens, webhook secrets and queued mails in a dump are sealed with
  it. Keep a copy of the Secret (`kubectl get secret pixeltwin -o yaml`) somewhere safe, apart from
  the dumps.
- **`local` mode with SQLite**: everything is on the PVC (`/data/pixeltwin.db` and the image
  files). Use volume snapshots (a `VolumeSnapshot` of `<release>-pixeltwin-data`) or a backup tool
  such as Velero. The image is distroless and has no shell or `tar`, so `kubectl cp` does not work.
  For a consistent copy of the database, scale to 0 first, or snapshot the volume.
- **`local` mode with Postgres**: `pg_dump` (or `backup.enabled`) has the metadata, but the images
  are files on the PVC. Back up both, the database first and then the volume, so that every image
  the dump refers to exists in the volume backup.

## Testing the chart

```sh
scripts/k8s/chart-check.sh   # helm lint, the settings it refuses, kubeconform (needs helm, kubeconform)
scripts/k8s/kind-smoke.sh    # the full smoke test on a throwaway kind cluster (needs kind, kubectl, helm, docker, bun)
```

The kind smoke test builds the image, installs the example Postgres and the chart with 3 replicas,
checks that one pod applied the migrations, runs `helm test`, then the smoke test against the
NodePort, a webhook to an in-cluster receiver that must arrive exactly once, and a
`kubectl rollout restart` in the middle of uploads that must not fail a single check. It uses its
own kubeconfig and deletes the cluster at the end (`KEEP_CLUSTER=1` keeps it). CI runs both.
