{{- define "pixeltwin.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "pixeltwin.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "pixeltwin.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "pixeltwin.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pixeltwin.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "pixeltwin.labels" -}}
helm.sh/chart: {{ include "pixeltwin.chart" . }}
{{ include "pixeltwin.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "pixeltwin.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "pixeltwin.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "pixeltwin.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/*
Labels of the chart's other pods (backup, helm test). Their app.kubernetes.io/name differs from the
server's, so neither the Deployment's selector nor the Service's ever matches them.
*/}}
{{- define "pixeltwin.componentLabels" -}}
{{- $ := index . 0 -}}
helm.sh/chart: {{ include "pixeltwin.chart" $ }}
app.kubernetes.io/name: {{ printf "%s-%s" (include "pixeltwin.name" $) (index . 1) }}
app.kubernetes.io/instance: {{ $.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
app.kubernetes.io/part-of: {{ include "pixeltwin.name" $ }}
app.kubernetes.io/managed-by: {{ $.Release.Service }}
{{- end }}

{{/* Pods with this label set to "true" may reach the http port when networkPolicy is on. */}}
{{- define "pixeltwin.clientLabel" -}}
{{- printf "%s-client" (include "pixeltwin.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Whole CPUs, rounded up, of a Kubernetes quantity ("2", 2, "1500m", "0.5"); 0 when empty. */}}
{{- define "pixeltwin.cpuCeil" -}}
{{- $q := toString . }}
{{- if or (eq $q "") (eq $q "<nil>") }}0
{{- else if hasSuffix "m" $q }}{{ div (add (int (trimSuffix "m" $q)) 999) 1000 }}
{{- else }}{{ int (ceil (float64 $q)) }}
{{- end }}
{{- end }}

{{/*
DIFF_WORKERS: diffWorkers, else the CPU limit (else the request) rounded up minus one, at least 1;
empty when the pod has no CPU value at all (the server then reads its cgroup and the node's cores).
*/}}
{{- define "pixeltwin.diffWorkers" -}}
{{- if ne (toString .Values.diffWorkers) "" }}
{{- .Values.diffWorkers }}
{{- else }}
{{- $res := .Values.resources | default dict }}
{{- $cpu := dig "limits" "cpu" "" $res }}
{{- if eq (toString $cpu) "" }}{{ $cpu = dig "requests" "cpu" "" $res }}{{ end }}
{{- $cores := int (include "pixeltwin.cpuCeil" $cpu) }}
{{- if gt $cores 0 }}{{ max 1 (sub $cores 1) }}{{ end }}
{{- end }}
{{- end }}

{{/* Shutdown settings; the old top-level preStopSleepSeconds / terminationGracePeriodSeconds still count. */}}
{{- define "pixeltwin.preStopSleep" -}}
{{- if hasKey .Values "preStopSleepSeconds" }}{{ int .Values.preStopSleepSeconds }}{{ else }}{{ int .Values.shutdown.preStopSleepSeconds }}{{ end }}
{{- end }}

{{- define "pixeltwin.terminationGrace" -}}
{{- if hasKey .Values "terminationGracePeriodSeconds" }}{{ int .Values.terminationGracePeriodSeconds }}
{{- else if ne (toString .Values.shutdown.terminationGracePeriodSeconds) "" }}{{ int .Values.shutdown.terminationGracePeriodSeconds }}
{{- else }}{{ add (int (include "pixeltwin.preStopSleep" .)) (int .Values.shutdown.graceSeconds) 10 }}
{{- end }}
{{- end }}

{{/*
The largest request body the server accepts, in MiB rounded up: the image as base64 plus 1 MiB
(Bun's maxRequestBodySize in src/server.ts), for the Ingress body size.
*/}}
{{- define "pixeltwin.bodySizeMiB" -}}
{{- $bytes := int (default 10485760 .Values.config.maxImageBytes) }}
{{- $limit := add (mul (div (add $bytes 2) 3) 4) 1048576 }}
{{- div (add $limit 1048575) 1048576 }}
{{- end }}

{{/* The Secret holding DATABASE_URL, SETUP_TOKEN, SECRET_KEY and SMTP_URL: the user's own, or the chart's. */}}
{{- define "pixeltwin.secretName" -}}
{{- default (include "pixeltwin.fullname" .) .Values.existingSecret }}
{{- end }}

{{/* `local` mode runs exactly one replica: a ReadWriteOnce volume, and SQLite has one writer. */}}
{{- define "pixeltwin.replicas" -}}
{{- if eq .Values.storage "local" }}1{{ else }}{{ int .Values.replicaCount }}{{ end }}
{{- end }}

{{/*
The setup token: the one from values, else the one already in the chart's Secret (so upgrades keep
it), else a new random one.
*/}}
{{- define "pixeltwin.setupToken" -}}
{{- if .Values.setupToken }}
{{- .Values.setupToken }}
{{- else }}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "pixeltwin.fullname" .) }}
{{- if and $existing $existing.data (hasKey $existing.data "SETUP_TOKEN") }}
{{- index $existing.data "SETUP_TOKEN" | b64dec }}
{{- else }}
{{- randAlphaNum 40 }}
{{- end }}
{{- end }}
{{- end }}

{{/* SECRET_KEY: secretKey, else the one already in the chart's Secret, else a new random one (kept across upgrades). */}}
{{- define "pixeltwin.secretKey" -}}
{{- if .Values.secretKey }}
{{- .Values.secretKey }}
{{- else }}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "pixeltwin.fullname" .) }}
{{- if and $existing $existing.data (hasKey $existing.data "SECRET_KEY") }}
{{- index $existing.data "SECRET_KEY" | b64dec }}
{{- else }}
{{- randAlphaNum 48 }}
{{- end }}
{{- end }}
{{- end }}

{{/* Fails the install or upgrade on settings that cannot work. */}}
{{- define "pixeltwin.validate" -}}
{{- if not .Values.publicUrl }}
{{- fail "publicUrl is required: the URL users and CI reach pixeltwin at, e.g. --set publicUrl=https://pixeltwin.example.com. The server uses it for links, the Secure cookie flag and the CSRF origin check." }}
{{- end }}
{{- if not (regexMatch "^https?://[^/]+" .Values.publicUrl) }}
{{- fail (printf "publicUrl must start with http:// or https://, got %q" .Values.publicUrl) }}
{{- end }}
{{- if and .Values.setupToken (lt (len .Values.setupToken) 16) }}
{{- fail "setupToken must be at least 16 characters (or leave it empty and the chart generates one)" }}
{{- end }}
{{- if and .Values.secretKey (lt (len .Values.secretKey) 32) }}
{{- fail "secretKey must be at least 32 characters (or leave it empty and the chart generates one)" }}
{{- end }}
{{- if not (has .Values.storage (list "local" "postgres")) }}
{{- fail (printf "storage must be \"local\" or \"postgres\", got %q" .Values.storage) }}
{{- end }}
{{- if and .Values.database.url (not (regexMatch "^postgres(ql)?://" .Values.database.url)) }}
{{- fail "database.url must start with postgres:// or postgresql://" }}
{{- end }}
{{- if and .Values.smtp.url (not .Values.smtp.from) }}
{{- fail "smtp.url needs smtp.from, the From of the mails, e.g. \"pixeltwin <pixeltwin@example.com>\"" }}
{{- end }}
{{- if and (eq .Values.storage "local") (gt (int .Values.replicaCount) 1) }}
{{- fail "replicaCount > 1 needs storage=postgres: local mode is a ReadWriteOnce volume and SQLite, one replica only" }}
{{- end }}
{{- $grace := int (include "pixeltwin.terminationGrace" .) }}
{{- $needed := add (int (include "pixeltwin.preStopSleep" .)) (int .Values.shutdown.graceSeconds) }}
{{- if le $grace $needed }}
{{- fail (printf "terminationGracePeriodSeconds (%d) must be above preStopSleepSeconds + shutdown.graceSeconds (%d), or the kubelet kills pods mid-drain" $grace $needed) }}
{{- end }}
{{- if and .Values.metrics.enabled (eq (int .Values.metrics.port) 8080) }}
{{- fail "metrics.port must not be 8080, the http port" }}
{{- end }}
{{- if and .Values.backup.enabled (not .Values.database.url) (not .Values.existingSecret) }}
{{- fail "backup.enabled dumps Postgres: set database.url or existingSecret" }}
{{- end }}
{{- if and (eq .Values.storage "postgres") (not .Values.database.url) (not .Values.existingSecret) }}
{{- fail "storage=postgres keeps images in Postgres: set database.url, or existingSecret with a DATABASE_URL key" }}
{{- end }}
{{- end }}
