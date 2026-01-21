{{- define "inspection-center.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "inspection-center.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "inspection-center.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
  {{- default (include "inspection-center.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
  {{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "inspection-center.frontendHttpsEnabled" -}}
{{- $env := .Values.frontend.env | default dict -}}
{{- if hasKey $env "FRONTEND_ENABLE_HTTPS" -}}
{{- $raw := (get $env "FRONTEND_ENABLE_HTTPS") | toString | lower | trim -}}
{{- if or (eq $raw "1") (eq $raw "true") (eq $raw "yes") (eq $raw "on") -}}
true
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "inspection-center.frontendTlsSecretName" -}}
{{- if .Values.frontend.tls.existingSecret -}}
{{- .Values.frontend.tls.existingSecret -}}
{{- else -}}
{{- printf "%s-frontend-tls" (include "inspection-center.fullname" .) -}}
{{- end -}}
{{- end -}}
