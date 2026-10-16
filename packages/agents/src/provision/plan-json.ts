/**
 * The engine's plan JSON (`show -json`) holds every value in clear text, sensitive ones included
 * (tokens, passwords), and only marks which are sensitive. Before OpsCrew keeps it (the
 * `.opscrew/plans/*.tfplan.json` sidecars) or evaluates policies on it, those values are replaced
 * by {@link SENSITIVE_VALUE} and the prior state (all values, unmarked) is dropped.
 */

import { isRecord } from "@opscrew/core";

/** What a sensitive value is replaced with. */
export const SENSITIVE_VALUE = "(sensitive value)";

type Json = Record<string, unknown>;

/**
 * `value` with every part `sensitive` marks replaced: `true` marks the whole value, an array or
 * object marks its elements or keys (the shape of `before_sensitive`, `after_sensitive` and
 * `sensitive_values`). `null` stays `null` (it reveals nothing).
 */
export function maskBySensitivity(value: unknown, sensitive: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (sensitive === true) return SENSITIVE_VALUE;
  if (Array.isArray(sensitive) && Array.isArray(value)) {
    return value.map((item, i) => maskBySensitivity(item, sensitive[i]));
  }
  if (isRecord(sensitive) && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskBySensitivity(item, sensitive[key])]),
    );
  }
  return value;
}

/**
 * Attributes masked whatever the plan marks, per resource type: the provider does not mark them
 * sensitive, but they reveal what must stay private. A Cloudflare Tunnel's `connections` list the
 * public address (`origin_ip`) of every host running its connector, such as the user's Portainer
 * host or a server behind the tunnel.
 */
const ALWAYS_MASKED: Readonly<Record<string, readonly string[]>> = {
  cloudflare_zero_trust_tunnel_cloudflared: ["connections"],
};

/** `values` (a resource object) with the attributes {@link ALWAYS_MASKED} for `type` replaced. */
function maskAlways(values: unknown, type: unknown): unknown {
  const attributes = typeof type === "string" ? ALWAYS_MASKED[type] : undefined;
  if (attributes === undefined || !isRecord(values)) return values;
  const out: Json = { ...values };
  for (const name of attributes) {
    if (out[name] !== undefined && out[name] !== null) out[name] = SENSITIVE_VALUE;
  }
  return out;
}

/** A `change` object (`before`/`after` with their sensitivity marks) of a resource of `type`. */
function maskChange(change: unknown, type?: unknown): unknown {
  if (!isRecord(change)) return change;
  const out: Json = { ...change };
  if ("before" in change) {
    out.before = maskAlways(maskBySensitivity(change.before, change.before_sensitive), type);
  }
  if ("after" in change) {
    out.after = maskAlways(maskBySensitivity(change.after, change.after_sensitive), type);
  }
  return out;
}

/** Resource changes or drift: each entry's `change`. */
function maskResourceChanges(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((entry) =>
    isRecord(entry) ? { ...entry, change: maskChange(entry.change, entry.type) } : entry,
  );
}

/** A planned module: its resources' `values` by `sensitive_values`, then its child modules. */
function maskModule(module: unknown): unknown {
  if (!isRecord(module)) return module;
  const out: Json = { ...module };
  if (Array.isArray(module.resources)) {
    out.resources = module.resources.map((resource) =>
      isRecord(resource)
        ? {
            ...resource,
            values: maskAlways(
              maskBySensitivity(resource.values, resource.sensitive_values),
              resource.type,
            ),
          }
        : resource,
    );
  }
  if (Array.isArray(module.child_modules)) out.child_modules = module.child_modules.map(maskModule);
  return out;
}

/** Outputs as `planned_values` lists them: `{ sensitive, value }`. */
function maskOutputs(outputs: unknown): unknown {
  if (!isRecord(outputs)) return outputs;
  return Object.fromEntries(
    Object.entries(outputs).map(([name, output]) => [
      name,
      isRecord(output) && output.sensitive === true && "value" in output
        ? { ...output, value: maskBySensitivity(output.value, true) }
        : output,
    ]),
  );
}

/** Names of the root module's variables the configuration marks `sensitive`. */
function sensitiveVariables(plan: Json): Set<string> {
  const configuration = isRecord(plan.configuration) ? plan.configuration : {};
  const root = isRecord(configuration.root_module) ? configuration.root_module : {};
  const variables = isRecord(root.variables) ? root.variables : {};
  return new Set(
    Object.entries(variables)
      .filter(([, spec]) => isRecord(spec) && spec.sensitive === true)
      .map(([name]) => name),
  );
}

/**
 * The plan JSON without the prior state and with every sensitive value replaced by
 * {@link SENSITIVE_VALUE}, for every provider: resource changes and drift (`before`/`after` by
 * `before_sensitive`/`after_sensitive`), planned resources (`values` by `sensitive_values`),
 * sensitive outputs, output changes, and the values and defaults of sensitive variables; and,
 * whatever the plan marks, the attributes of {@link ALWAYS_MASKED} (a Cloudflare Tunnel's
 * `connections`, which hold the public address of every host running its connector). Anything
 * else is kept as it is, so policies and summaries see every non-sensitive value. Idempotent.
 */
export function maskSensitivePlanJson(planJson: unknown): unknown {
  if (!isRecord(planJson)) return planJson;
  const { prior_state: _prior, ...plan } = planJson;
  const out: Json = { ...plan };
  if ("resource_changes" in plan) out.resource_changes = maskResourceChanges(plan.resource_changes);
  if ("resource_drift" in plan) out.resource_drift = maskResourceChanges(plan.resource_drift);
  if (isRecord(plan.planned_values)) {
    out.planned_values = {
      ...plan.planned_values,
      ...("root_module" in plan.planned_values
        ? { root_module: maskModule(plan.planned_values.root_module) }
        : {}),
      ...("outputs" in plan.planned_values
        ? { outputs: maskOutputs(plan.planned_values.outputs) }
        : {}),
    };
  }
  if (isRecord(plan.output_changes)) {
    out.output_changes = Object.fromEntries(
      Object.entries(plan.output_changes).map(([name, change]) => [name, maskChange(change)]),
    );
  }
  const secretVariables = sensitiveVariables(plan);
  if (secretVariables.size > 0 && isRecord(plan.variables)) {
    out.variables = Object.fromEntries(
      Object.entries(plan.variables).map(([name, variable]) => [
        name,
        secretVariables.has(name) && isRecord(variable) && "value" in variable
          ? { ...variable, value: maskBySensitivity(variable.value, true) }
          : variable,
      ]),
    );
  }
  if (secretVariables.size > 0 && isRecord(plan.configuration)) {
    const root = isRecord(plan.configuration.root_module) ? plan.configuration.root_module : {};
    const variables = isRecord(root.variables) ? root.variables : {};
    out.configuration = {
      ...plan.configuration,
      root_module: {
        ...root,
        variables: Object.fromEntries(
          Object.entries(variables).map(([name, spec]) => [
            name,
            secretVariables.has(name) && isRecord(spec) && "default" in spec
              ? { ...spec, default: maskBySensitivity(spec.default, true) }
              : spec,
          ]),
        ),
      },
    };
  }
  return out;
}
