// YAML entry point for Agent Job specs. The `yaml` package is loaded lazily so
// importing agent-job-spec.js never requires it. Anchors, aliases and custom
// tags are rejected: a job file must read the same to humans and the parser.
import { AgentJobSpecError, validateAgentJobSpec } from "./agent-job-spec.js";

const MAX_YAML_BYTES = 256 * 1024;

async function loadYaml() {
  try {
    return await import("yaml");
  } catch {
    const error = new Error("yaml_parser_unavailable");
    error.code = "yaml_parser_unavailable";
    throw error;
  }
}

export async function parseAgentJobYaml(text) {
  if (typeof text !== "string") throw new AgentJobSpecError([{ path: "$", code: "invalid_type", message: "expected YAML text" }]);
  if (Buffer.byteLength(text, "utf8") > MAX_YAML_BYTES) {
    throw new AgentJobSpecError([{ path: "$", code: "too_long", message: `job file larger than ${MAX_YAML_BYTES} bytes` }]);
  }
  const { parseDocument, visit, isAlias, isNode } = await loadYaml();
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  const errors = doc.errors.map((error) => ({ path: "$", code: "yaml_syntax", message: error.message }));
  visit(doc, (_key, node) => {
    if (isAlias(node)) errors.push({ path: "$", code: "yaml_alias", message: "YAML aliases are not allowed" });
    else if (isNode(node) && node.anchor) errors.push({ path: "$", code: "yaml_anchor", message: "YAML anchors are not allowed" });
    else if (isNode(node) && node.tag && !node.tag.startsWith("tag:yaml.org,2002:")) {
      errors.push({ path: "$", code: "yaml_tag", message: `YAML tag ${node.tag} is not allowed` });
    }
  });
  if (errors.length) throw new AgentJobSpecError(errors);
  return doc.toJS();
}

export async function loadAgentJobYaml(text) {
  const result = validateAgentJobSpec(await parseAgentJobYaml(text));
  if (!result.ok) throw new AgentJobSpecError(result.errors);
  return result.spec;
}
