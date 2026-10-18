{{/*
Names, labels, and what the chart derives from the components
(docs/decisions/helm-chart.md, fork 2). The templates ask these; nothing
else in the chart knows which module a target is.
*/}}

{{- define "casas-eternas.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "casas-eternas.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{- define "casas-eternas.labels" -}}
app.kubernetes.io/name: {{ include "casas-eternas.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end }}

{{- define "casas-eternas.selectorLabels" -}}
app.kubernetes.io/name: {{ include "casas-eternas.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "casas-eternas.image" -}}
{{- with .Values.image.registry }}{{ . }}/{{ end }}{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end }}

{{/* The modules, as the server names its targets (internal/config). */}}
{{- define "casas-eternas.modules" -}}
client,world,artifacts,jobs,docs,auth,relay
{{- end }}

{{/*
A component's modules, comma-separated: its targets with `all` expanded.
Call with (dict "root" $ "component" $component).
*/}}
{{- define "casas-eternas.modulesOf" -}}
{{- $targets := .component.targets | default list -}}
{{- if has "all" $targets -}}
{{- include "casas-eternas.modules" .root -}}
{{- else -}}
{{- join "," $targets -}}
{{- end -}}
{{- end }}

{{/*
The component that runs `module`, or "" when none does.
Call with (dict "root" $ "module" "world").
*/}}
{{- define "casas-eternas.componentOf" -}}
{{- $root := .root -}}
{{- $module := .module -}}
{{- range $name, $component := $root.Values.components -}}
{{- if has $module (splitList "," (include "casas-eternas.modulesOf" (dict "root" $root "component" $component))) -}}
{{- $name -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The component the Ingress sends `/` and /v1/capabilities to: the one with
the client, or else the first by name.
*/}}
{{- define "casas-eternas.front" -}}
{{- $front := include "casas-eternas.componentOf" (dict "root" . "module" "client") -}}
{{- if and (not $front) .Values.components -}}{{- $front = keys .Values.components | sortAlpha | first -}}{{- end -}}
{{- $front -}}
{{- end }}

{{/* A component's resource name: <fullname>-<component>. */}}
{{- define "casas-eternas.componentName" -}}
{{- printf "%s-%s" (include "casas-eternas.fullname" .root) .name | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{/* openshift or kubernetes (fork 7). */}}
{{- define "casas-eternas.platform" -}}
{{- if eq .Values.platform "auto" -}}
{{- if .Capabilities.APIVersions.Has "route.openshift.io/v1" -}}openshift{{- else -}}kubernetes{{- end -}}
{{- else -}}
{{- .Values.platform -}}
{{- end -}}
{{- end }}

{{/* Whether a store keeps its objects on the component's volume. */}}
{{- define "casas-eternas.storeOnDir" -}}
{{- $section := index .Values.config .store | default dict -}}
{{- $storage := $section.storage | default dict -}}
{{- if eq ($storage.type | default "dir") "dir" -}}true{{- end -}}
{{- end }}

{{/*
Whether a component keeps state on disk: auth, jobs and relay always, world
and artifacts on the dir backend. Call with (dict "root" $ "modules" $list).
*/}}
{{- define "casas-eternas.needsVolume" -}}
{{- $m := .modules -}}
{{- if or (has "auth" $m) (has "jobs" $m) (has "relay" $m) -}}true
{{- else if and (has "world" $m) (include "casas-eternas.storeOnDir" (dict "Values" .root.Values "store" "world")) -}}true
{{- else if and (has "artifacts" $m) (include "casas-eternas.storeOnDir" (dict "Values" .root.Values "store" "artifacts")) -}}true
{{- end -}}
{{- end }}

{{/* Whether the server scales the worker Deployment. */}}
{{- define "casas-eternas.scalesWorkers" -}}
{{- if and .Values.workers.enabled (include "casas-eternas.componentOf" (dict "root" . "module" "jobs")) -}}true{{- end -}}
{{- end }}

{{/*
What cannot run, refused at install (fork 2): every module exactly once,
replicas only for a stateless component, the workers' addresses where no
component runs jobs.
*/}}
{{- define "casas-eternas.validate" -}}
{{- $root := . -}}
{{- $seen := dict -}}
{{- range $name, $component := .Values.components -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $name) -}}
{{- fail (printf "components.%s: a component's name must be a DNS label (lower case, digits, '-')" $name) -}}
{{- end -}}
{{- if not $component.targets -}}
{{- fail (printf "components.%s: no targets" $name) -}}
{{- end -}}
{{- range $target := $component.targets -}}
{{- if not (has $target (append (splitList "," (include "casas-eternas.modules" $root)) "all")) -}}
{{- fail (printf "components.%s: %q is no target (one of: all, %s)" $name $target (include "casas-eternas.modules" $root)) -}}
{{- end -}}
{{- end -}}
{{- if and (has "all" $component.targets) (gt (len $component.targets) 1) -}}
{{- fail (printf "components.%s: `all` is every target already; list it alone" $name) -}}
{{- end -}}
{{- $modules := splitList "," (include "casas-eternas.modulesOf" (dict "root" $root "component" $component)) -}}
{{- range $module := $modules -}}
{{- if hasKey $seen $module -}}
{{- fail (printf "the target %s is in components %s and %s: two processes would serve one module (one store, one process). Helm merges maps, so the default component stays unless removed: set components.server to null" $module (get $seen $module) $name) -}}
{{- end -}}
{{- $_ := set $seen $module $name -}}
{{- end -}}
{{- $stateless := true -}}
{{- range $module := $modules -}}
{{- if not (has $module (list "client" "docs")) -}}{{- $stateless = false -}}{{- end -}}
{{- end -}}
{{- if and (gt (int ($component.replicas | default 1)) 1) (not $stateless) -}}
{{- fail (printf "components.%s: replicas %v, but only a component of client and docs alone may have more than one (its targets keep state in the process)" $name $component.replicas) -}}
{{- end -}}
{{- end -}}
{{- /* No component at all is workers alone; a server needs every target. */ -}}
{{- if .Values.components -}}
{{- range $module := splitList "," (include "casas-eternas.modules" $root) -}}
{{- if not (hasKey $seen $module) -}}
{{- fail (printf "the target %s is in no component: add it to one (or use `all`)" $module) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and .Values.workers.enabled (not (hasKey $seen "jobs")) -}}
{{- if or (not .Values.workers.server.relay) (not .Values.workers.server.api) -}}
{{- fail "workers alone (no component runs jobs) need workers.server.relay and workers.server.api: the server they work for" -}}
{{- end -}}
{{- end -}}
{{- if not (has (.Values.platform | toString) (list "auto" "openshift" "kubernetes")) -}}
{{- fail (printf "platform: %q is not one of auto, openshift, kubernetes" .Values.platform) -}}
{{- end -}}
{{- end }}

{{/*
The pod's security context: none on OpenShift (its SCC assigns an
arbitrary UID in GID 0, which the image is built for), the image's user on
Kubernetes. The values' podSecurityContext replaces it.
Call with (dict "root" $ "override" $podSecurityContext).
*/}}
{{- define "casas-eternas.podSecurityContext" -}}
{{- if .override -}}
{{- toYaml .override -}}
{{- else if eq (include "casas-eternas.platform" .root) "kubernetes" -}}
runAsUser: 1001
runAsGroup: 1001
fsGroup: 1001
fsGroupChangePolicy: OnRootMismatch
{{- end -}}
{{- end }}

{{/* The container's security context: hardened, restricted-v2 friendly. */}}
{{- define "casas-eternas.securityContext" -}}
{{- if . -}}
{{- toYaml . -}}
{{- else -}}
runAsNonRoot: true
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end -}}
{{- end }}

{{/* Where a role's Secret is mounted. */}}
{{- define "casas-eternas.secretDir" -}}
/etc/casas-eternas/secrets/{{ . }}
{{- end }}
