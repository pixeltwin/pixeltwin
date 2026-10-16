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

{{/* The Secret holding DATABASE_URL and SETUP_TOKEN: the user's own, or the chart's. */}}
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

{{/* Fails the install or upgrade on settings that cannot work. */}}
{{- define "pixeltwin.validate" -}}
{{- if not .Values.publicUrl }}
{{- fail "publicUrl is required: the URL users and CI reach pixeltwin at, e.g. --set publicUrl=https://vrt.example.com. The server uses it for links, the Secure cookie flag and the CSRF origin check." }}
{{- end }}
{{- if not (regexMatch "^https?://[^/]+" .Values.publicUrl) }}
{{- fail (printf "publicUrl must start with http:// or https://, got %q" .Values.publicUrl) }}
{{- end }}
{{- if and .Values.setupToken (lt (len .Values.setupToken) 16) }}
{{- fail "setupToken must be at least 16 characters (or leave it empty and the chart generates one)" }}
{{- end }}
{{- if not (has .Values.storage (list "local" "postgres")) }}
{{- fail (printf "storage must be \"local\" or \"postgres\", got %q" .Values.storage) }}
{{- end }}
{{- if and .Values.database.url (not (regexMatch "^postgres(ql)?://" .Values.database.url)) }}
{{- fail "database.url must start with postgres:// or postgresql://" }}
{{- end }}
{{- if and (eq .Values.storage "postgres") (not .Values.database.url) (not .Values.existingSecret) }}
{{- fail "storage=postgres keeps images in Postgres: set database.url, or existingSecret with a DATABASE_URL key" }}
{{- end }}
{{- end }}
