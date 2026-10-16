# pixeltwin Helm chart

Deploys [pixeltwin](../../../README.md) to Kubernetes 1.30 or later.

## Install

The chart is not published to a chart repository yet; install it from a checkout:

```sh
helm install pixeltwin deploy/helm/pixeltwin -n pixeltwin --create-namespace \
  --set image.repository=ghcr.io/<owner>/pixeltwin \
  --set publicUrl=https://vrt.example.com \
  --set ingress.enabled=true --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=vrt.example.com' --set 'ingress.hosts[0].paths[0].path=/'
```

The install notes show how to create the first admin. In short:

```sh
TOKEN=$(kubectl -n pixeltwin get secret pixeltwin -o jsonpath='{.data.SETUP_TOKEN}' | base64 -d)
open "https://vrt.example.com/ui/setup?token=$TOKEN"
```

The chart writes a random `SETUP_TOKEN` to its Secret (or uses `setupToken`, at least 16
characters), and keeps it across upgrades. Every replica accepts it. The server never logs a token
that comes from `SETUP_TOKEN`. Once a user exists the token is refused. With `existingSecret` and
no `SETUP_TOKEN` key in it, each pod makes up its own token and logs it
(`kubectl logs … | grep setupUrl`); only the pod that logged it accepts it.

### `publicUrl` is required

Set it to the address people and CI use, for example `https://vrt.example.com`. A path prefix
is allowed. The server needs it for three things:

- **Links**: the setup link, the CI snippets in the UI, `/llms.txt`, and the prefix of every UI link
  and redirect.
- **Cookies**: the session cookie gets the `Secure` flag when the URL is `https://`.
- **CSRF**: browser requests authenticated by cookie (any method except GET and HEAD) must send an
  `Origin` equal to this URL's origin, or they get `403 csrf_origin_mismatch`.

The server's default is `http://localhost:8080`. With that default, logging in through an Ingress
would seem to work, but every button and form in the UI would then fail. For this reason the
chart refuses to install without `publicUrl`. For a quick try with a port-forward, use
`--set publicUrl=http://localhost:8080` and
`kubectl port-forward svc/pixeltwin 8080:80`.

## The two storage modes

| | `storage: local` (default) | `storage: postgres` |
|---|---|---|
| Images | files on a PVC at `/data` | in the Postgres database (`stored_objects` table) |
| Database | SQLite on the PVC, or Postgres when `database.url` is set | Postgres, `database.url` required |
| Replicas | always 1 (`replicaCount` is ignored) | any |
| Volume | PVC, ReadWriteOnce (`persistence.*`) | none (an emptyDir as the working dir) |
| Update strategy | `Recreate`: the old pod stops before the new one starts | `RollingUpdate`, maxSurge 1, maxUnavailable 0 |
| Backup | the PVC and, with Postgres, the database | one `pg_dump` |

`local` is for a single instance: the volume is ReadWriteOnce, and SQLite allows one writer. An
upgrade or a restart therefore has a few seconds of downtime. The PVC has
`helm.sh/resource-policy: keep`, so `helm uninstall` leaves your data. Delete the PVC yourself
when you mean to.

`postgres` keeps everything in the database, so pods hold no state. You can scale them, roll them
or reschedule them freely. A minimal Postgres for trying it out is in
[`deploy/examples/postgres.yaml`](../../examples/postgres.yaml). For production, use a managed
database or an operator. Every pod opens up to `database.poolMax` (20) connections, so keep
`replicaCount × poolMax` under the server's `max_connections`. The hourly retention job takes a
Postgres advisory lock, so only one replica runs it.

```sh
kubectl -n pixeltwin create secret generic pixeltwin-db \
  --from-literal=DATABASE_URL='postgres://pixeltwin:…@db.internal:5432/pixeltwin' \
  --from-literal=SETUP_TOKEN="$(openssl rand -hex 20)"
helm install pixeltwin deploy/helm/pixeltwin -n pixeltwin \
  --set storage=postgres --set replicaCount=3 --set existingSecret=pixeltwin-db \
  --set publicUrl=https://vrt.example.com
```

Images in Postgres grow the database at about the rate the files would grow on disk; each image is
stored once by its hash. Builds older than a project's retention period are deleted every hour,
together with the images nothing references any more.

## Values

The full list with comments is in [`values.yaml`](values.yaml). The main ones:

| Value | Default | |
|---|---|---|
| `publicUrl` | (required) | see above |
| `storage` | `local` | `local` or `postgres` |
| `replicaCount` | `1` | `postgres` mode only |
| `database.url` | | `postgres://…`; written to the chart's Secret |
| `database.poolMax` | `20` | `DATABASE_POOL_MAX` per pod |
| `existingSecret` | | your own Secret with `DATABASE_URL` and/or `SETUP_TOKEN` (key names in `existingSecretKeys`) |
| `setupToken` | generated | first-run setup token, ≥ 16 characters |
| `diffWorkers` | server default | `DIFF_WORKERS`; the server uses the pod's CPU limit − 1 (at least 1) |
| `config.*` | server defaults | `logLevel`, `diffTimeoutMs`, `diffQueueMax`, `maxImageBytes`, `maxImagePixels` |
| `resources` | requests 500m / 2Gi, limits 2 CPU / 2560Mi | |
| `persistence.size` / `storageClass` / `existingClaim` | `20Gi` / default / | `local` mode |
| `ingress.*` | disabled | annotations default to `proxy-body-size: 20m` and 120 s timeouts for ingress-nginx |
| `probes.*` | startup, readiness, liveness on `/healthz` | |
| `preStopSleepSeconds` | `5` | lets endpoints drop the pod before it gets SIGTERM |
| `podDisruptionBudget` | `maxUnavailable: 1` | only with more than one replica |

**Resources.** Under heavy parallel uploads with 10 diff workers, one pod used about 1.5 to 2 GB
of RAM ([load testing](../../../docs/load-testing.md)). An idle pod uses about 130 MiB. With
fewer workers, a pod needs less memory. When you raise `resources.limits.cpu`, the default
`diffWorkers` follows it.

**Upload size.** An upload is at most `MAX_IMAGE_BYTES` (10 MiB) as multipart, or about 13.4 MB
when sent as base64 JSON. ingress-nginx refuses bodies over 1 MB by default, so the chart sets
`nginx.ingress.kubernetes.io/proxy-body-size: 20m`. Other ingress controllers need an equivalent
setting. Uploads wait for their diff, so the read timeout is raised as well.

**Probes.** `/healthz` checks the database and the storage. The readiness probe takes a pod out of
the Service while its database is unreachable. The liveness probe allows two minutes (6 × 20 s)
before it restarts the pod, because a restart does not fix the database.

**Security.** The pod runs as uid/gid 65532, the distroless `nonroot` user. It has a read-only
root filesystem, no capabilities, `RuntimeDefault` seccomp and no service account token.
`fsGroup: 65532` makes the PVC writable. `/data` and `/tmp` are the only writable paths.

## Upgrading

```sh
helm upgrade pixeltwin deploy/helm/pixeltwin -n pixeltwin --reuse-values --set image.tag=<version>
```

Pods apply pending database migrations at startup. In `postgres` mode, several pods that start at
once take turns through the migrator's lock: one applies the migrations, and the others find
nothing left to do. During a rolling update, old pods keep serving against the migrated database
until they are replaced. Rolling the image back does not undo migrations, so take a backup before
an upgrade.

Changing `database.url` or `setupToken` restarts the pods. Changes inside an `existingSecret` do
not restart them, so run `kubectl rollout restart deployment/pixeltwin` yourself.

Switching an existing install between `local` and `postgres` does not move the images. Images
already on the PVC are not copied into the database.

## Backups

- **`postgres` mode**: `pg_dump` covers everything: users, projects, builds, baselines and the
  image bytes.

  ```sh
  kubectl -n pixeltwin exec pixeltwin-postgres-0 -- pg_dump -U pixeltwin -Fc pixeltwin > pixeltwin.dump
  ```

- **`local` mode with SQLite**: everything is on the PVC (`/data/pixeltwin.db` and the image
  files). Use volume snapshots (a `VolumeSnapshot` of `<release>-pixeltwin-data`) or a backup tool
  such as Velero. The image is distroless and has no shell or `tar`, so `kubectl cp` does not work.
  For a consistent copy of the database, scale to 0 first, or snapshot the volume.
- **`local` mode with Postgres**: `pg_dump` has the metadata, but the images are files on the PVC.
  Back up both, the database first and then the volume, so that every image the dump refers to
  exists in the volume backup.
