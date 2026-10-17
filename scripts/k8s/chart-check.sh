#!/usr/bin/env bash
# Lints and validates the Helm chart: helm lint in both storage modes, the settings it must refuse,
# and kubeconform on what it renders (with every optional part on) against a recent Kubernetes.
#   scripts/k8s/chart-check.sh            needs helm and kubeconform on PATH
#   KUBERNETES_VERSION=1.33.0 scripts/k8s/chart-check.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
chart=deploy/helm/pixeltwin
k8s="${KUBERNETES_VERSION:-1.33.0}"
url=https://pixeltwin.example.com
pg=postgres://u:p@db:5432/pixeltwin

echo "== helm lint"
helm lint "$chart" --strict --set publicUrl=$url
helm lint "$chart" --strict --set publicUrl=$url,storage=postgres,database.url=$pg,replicaCount=3,ingress.enabled=true
helm lint "$chart" --strict --set publicUrl=$url,storage=postgres,existingSecret=pixeltwin-db,replicaCount=2 \
  --set metrics.enabled=true,networkPolicy.enabled=true,backup.enabled=true

echo "== settings the chart refuses"
refuse() {
  if helm template t "$chart" "$@" >/dev/null 2>&1; then echo "accepted, but must be refused: $*" >&2; exit 1; fi
  echo "refused: ${*:-(no values)}"
}
refuse                                                          # no publicUrl
refuse --set publicUrl=ftp://pixeltwin.example.com              # not http(s)
refuse --set publicUrl=$url,storage=postgres                    # no database URL
refuse --set publicUrl=$url,replicaCount=3                      # several replicas on local storage
refuse --set publicUrl=$url,setupToken=short                    # setup token under 16 characters
refuse --set publicUrl=$url,secretKey=short                     # secret key under 32 characters
refuse --set publicUrl=$url,smtp.url=smtp://u:p@mail:587        # SMTP without a From
refuse --set publicUrl=$url,database.url=mysql://db             # not Postgres
refuse --set publicUrl=$url,diffWorkers=many                    # not a number
refuse --set publicUrl=$url,outbound.blockPrivate=maybe         # not a boolean
refuse --set publicUrl=$url,backup.enabled=true                 # nothing to dump
refuse --set publicUrl=$url,shutdown.terminationGracePeriodSeconds=20   # shorter than the drain

echo "== kubeconform (Kubernetes $k8s)"
render() { helm template pixeltwin "$chart" --namespace pixeltwin "$@"; }
{
  render --set publicUrl=$url
  echo "---"
  render --set publicUrl=$url,storage=postgres,database.url=$pg,replicaCount=3 \
    --set ingress.enabled=true,ingress.className=nginx \
    --set 'ingress.tls[0].secretName=pixeltwin-tls,ingress.tls[0].hosts[0]=pixeltwin.example.com' \
    --set metrics.enabled=true,metrics.serviceMonitor.enabled=true \
    --set networkPolicy.enabled=true,backup.enabled=true \
    --set smtp.url=smtp://u:p@mail:587,smtp.from=pixeltwin@example.com
} | kubeconform -strict -summary -kubernetes-version "$k8s" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
