/**
 * The engine's plan JSON (`show -json`) holds every value in clear text, sensitive ones included
 * (tokens, passwords), and only marks which are sensitive. Before OpsCrew keeps it (the
 * `.opscrew/plans/*.tfplan.json` sidecars) or evaluates policies on it, those values are replaced
 * by {@link SENSITIVE_VALUE} and the prior state (all values, unmarked) is dropped.
 */

/** What a sensitive value is replaced with. */
export const SENSITIVE_VALUE = "(sensitive value)";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** A `change` object (`before`/`after` with their sensitivity marks). */
function maskChange(change: unknown): unknown {
  if (!isRecord(change)) return change;
  const out: Json = { ...change };
  if ("before" in change) out.before = maskBySensitivity(change.before, change.before_sensitive);
  if ("after" in change) out.after = maskBySensitivity(change.after, change.after_sensitive);
  return out;
}

/** Resource changes or drift: each entry's `change`. */
function maskResourceChanges(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((entry) =>
    isRecord(entry) ? { ...entry, change: maskChange(entry.change) } : entry,
  );
}

/** A planned module: its resources' `values` by `sensitive_values`, then its child modules. */
function maskModule(module: unknown): unknown {
  if (!isRecord(module)) return module;
  const out: Json = { ...module };
  if (Array.isArray(module.resources)) {
    out.resources = module.resources.map((resource) =>
      isRecord(resource)
        ? { ...resource, values: maskBySensitivity(resource.values, resource.sensitive_values) }
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
 * sensitive outputs, output changes, and the values and defaults of sensitive variables. Anything
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
