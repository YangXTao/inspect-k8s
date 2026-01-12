{{- define "inspection-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "inspection-agent.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "inspection-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "inspection-agent.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "inspection-agent.clusterRoleName" -}}
{{- default (include "inspection-agent.fullname" .) .Values.rbac.clusterRoleName -}}
{{- end -}}

{{- define "inspection-agent.clusterRoleBindingName" -}}
{{- default (include "inspection-agent.fullname" .) .Values.rbac.clusterRoleBindingName -}}
{{- end -}}

{{- define "inspection-agent.configMapName" -}}
{{- include "inspection-agent.fullname" . -}}
{{- end -}}

{{- define "inspection-agent.secretName" -}}
{{- default (include "inspection-agent.fullname" .) .Values.secret.name -}}
{{- end -}}
