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
