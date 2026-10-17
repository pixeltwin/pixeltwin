#!/usr/bin/env bash
# Smoke test of the Helm chart on kind: builds the image, installs the example Postgres and the
# chart with 3 replicas in postgres mode, runs `helm test`, then scripts/k8s/exercise.ts (setup,
# checks, a webhook delivered once, a rolling restart mid-upload without failed checks).
#
#   scripts/k8s/kind-smoke.sh                 creates the kind cluster pixeltwin-smoke, deletes it at the end
#   KEEP_CLUSTER=1 scripts/k8s/kind-smoke.sh  leaves it running (KUBECONFIG is printed)
#   SKIP_BUILD=1 IMAGE=pixeltwin:smoke …      uses an image you built already
#
# It uses its own kubeconfig file and never touches your current kubectl context. Host ports:
# HTTP_PORT (18680) for pixeltwin, ECHO_PORT (18681) for the webhook receiver.
set -euo pipefail
cd "$(dirname "$0")/../.."

cluster="${KIND_CLUSTER:-pixeltwin-smoke}"
ns=pixeltwin
release=pixeltwin
http_port="${HTTP_PORT:-18680}"
echo_port="${ECHO_PORT:-18681}"
image="${IMAGE:-pixeltwin:smoke}"
work="$(mktemp -d "${TMPDIR:-/tmp}/pixeltwin-kind.XXXXXX")"
export KUBECONFIG="$work/kubeconfig"

t0=$SECONDS
phase_start=$SECONDS
phase() { echo; echo "== [$((SECONDS - t0)) s] $*"; phase_start=$SECONDS; }
took() { echo "   took $((SECONDS - phase_start)) s"; }

cleanup() {
  status=$?
  if [ $status -ne 0 ] && [ -s "$KUBECONFIG" ]; then
    echo "== failed: state for debugging"
    kubectl -n $ns get pods -o wide || true
    kubectl -n $ns get events --sort-by=.lastTimestamp | tail -30 || true
    kubectl -n $ns logs -l app.kubernetes.io/name=pixeltwin --prefix --tail=50 || true
  fi
  if [ "${KEEP_CLUSTER:-}" = 1 ]; then
    echo "cluster kept: KUBECONFIG=$KUBECONFIG kubectl -n $ns get pods"
  else
    kind delete cluster --name "$cluster" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1 || true
    rm -rf "$work"
  fi
  exit $status
}
trap cleanup EXIT

phase "kind cluster $cluster (1 control plane, 2 workers)"
cat > "$work/kind.yaml" <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - { containerPort: 30080, hostPort: $http_port, listenAddress: 127.0.0.1 }
      - { containerPort: 30081, hostPort: $echo_port, listenAddress: 127.0.0.1 }
  - role: worker
  - role: worker
YAML
kind create cluster --name "$cluster" --config "$work/kind.yaml" --kubeconfig "$KUBECONFIG" --wait 120s
took

phase "image $image"
if [ "${SKIP_BUILD:-}" != 1 ]; then docker build -t "$image" .; fi
# One platform per archive: `kind load docker-image` fails on multi-platform images when Docker
# uses the containerd image store (content of the other platforms is missing).
platform="linux/$(docker version --format '{{.Server.Arch}}')"
for ref in "$image" postgres:17 oven/bun:1.3.13-alpine; do
  [ "$ref" = "$image" ] || docker pull -q --platform "$platform" "$ref" >/dev/null
  docker save --platform "$platform" "$ref" -o "$work/image.tar"
  kind load image-archive --name "$cluster" "$work/image.tar"
done
rm -f "$work/image.tar"
took

phase "Postgres (deploy/examples/postgres.yaml) and the webhook receiver"
kubectl create namespace $ns
kubectl -n $ns apply -f deploy/examples/postgres.yaml -f scripts/k8s/echo-receiver.yaml
kubectl -n $ns rollout status statefulset/pixeltwin-postgres --timeout=180s
kubectl -n $ns rollout status deployment/pixeltwin-echo --timeout=120s
took

phase "helm install: 3 replicas, postgres mode, all starting (and migrating) at once"
helm install $release deploy/helm/pixeltwin -n $ns -f scripts/k8s/smoke-values.yaml \
  --set image.repository="${image%:*}",image.tag="${image##*:}" \
  --set publicUrl="http://localhost:$http_port" \
  --wait --timeout 5m
kubectl -n $ns get pods -o wide
took

phase "migrations ran once across the 3 pods"
applied=$(kubectl -n $ns logs -l app.kubernetes.io/name=pixeltwin --tail=-1 | grep -c '"msg":"migrations applied"' || true)
echo "   pods that applied migrations: $applied"
[ "$applied" = 1 ] || { echo "expected exactly one pod to apply the migrations" >&2; exit 1; }
spread=$(kubectl -n $ns get pods -l app.kubernetes.io/name=pixeltwin -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort -u | wc -l | tr -d ' ')
echo "   nodes the 3 replicas run on: $spread"
took

phase "helm test"
helm test $release -n $ns --logs
took

phase "exercise: setup, checks, webhook once, rolling restart mid-upload"
token=$(kubectl -n $ns get secret $release -o jsonpath='{.data.SETUP_TOKEN}' | base64 -d)
bun scripts/k8s/exercise.ts --url "http://localhost:$http_port" --token "$token" \
  --echo "http://localhost:$echo_port" --hook-url "http://pixeltwin-echo.$ns.svc.cluster.local/hook" \
  --namespace $ns --deployment $release
took

phase "metrics from inside the cluster"
kubectl -n $ns exec deploy/pixeltwin-echo -- bun -e \
  "const t = await (await fetch('http://$release-metrics.$ns.svc:9464/metrics')).text(); \
   for (const m of ['pixeltwin_checks_total', 'pixeltwin_outbox_pending', 'pixeltwin_http_request_duration_seconds_count']) \
     if (!t.includes(m)) { console.error('missing ' + m); process.exit(1); } \
   console.log(t.split('\n').filter((l) => /^pixeltwin_(checks_total|builds_finalized_total|outbox_pending|diff_queue_depth)/.test(l)).join('\n'))"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$http_port/metrics")
echo "   /metrics on the public port: HTTP $code"
[ "$code" = 404 ]
took

echo
echo "kind smoke: ok in $((SECONDS - t0)) s"
