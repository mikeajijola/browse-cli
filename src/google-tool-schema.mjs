/** Gemini rejects required recursive JSON-value unions. Keep the tool envelope
 * precise while describing recursive leaves as unconstrained JSON. The host's
 * original Zod and OmniForm validators still validate every actual tool call. */
export function googleToolSchema(schema) {
  let nodes = 0;
  function visit(value, refs = new Set(), depth = 0) {
    if (++nodes > 20000 || depth > 64)
      throw new Error("Tool schema exceeds Google conversion limits");
    if (Array.isArray(value))
      return value.map((item) => visit(item, refs, depth + 1));
    if (!value || typeof value !== "object") return value;
    if (typeof value.$ref === "string") {
      const ref = value.$ref;
      if (!ref.startsWith("#/"))
        throw new Error("External tool schema references are unsupported");
      if (refs.has(ref)) return {};
      const target = ref
        .slice(2)
        .split("/")
        .reduce(
          (node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
          schema,
        );
      if (!target) throw new Error("Unresolved tool schema reference");
      const next = new Set(refs);
      next.add(ref);
      const { $ref, ...siblings } = value;
      return {
        ...visit(target, next, depth + 1),
        ...visit(siblings, next, depth + 1),
      };
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["$defs", "definitions", "$schema"].includes(key))
        .map(([key, item]) => [key, visit(item, refs, depth + 1)]),
    );
  }
  return visit(schema);
}
