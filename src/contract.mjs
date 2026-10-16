import fs from "node:fs";
import { hash, inside, now } from "./util.mjs";

export function contractProgress(contract) {
  if (!contract) return null;
  const completed = contract.criteria.filter((item) => item.status === "completed").length;
  return { version: contract.version, objective: contract.objective, completed,
    total: contract.criteria.length, complete: completed === contract.criteria.length };
}

export function readContract(store, runId) {
  const run = store.run(runId);
  return {
    contract: run.contract || null,
    progress: contractProgress(run.contract),
    sources: [
      { id: `task:${run.step}`, text: run.steps[run.step]?.task || run.task },
      ...run.inputs.flatMap((input, index) => input.steering || input.answer
        ? [{ id: `input:${index}`, text: input.steering || input.answer }] : []),
    ],
  };
}

// Intent revisions are immutable; evidence is a separate, cumulative ledger.
export function reviseContract(store, runId, change) {
  const run = store.run(runId), previous = run.contract;
  const version = previous?.version || 0;
  const source = readContract(store, runId).sources.find((item) => item.id === change.sourceId);
  if (!source?.text) throw Error("Contract revisions require a saved user instruction source");
  if (typeof change.objective !== "string" || !change.objective.trim() || change.objective.length > 8000 ||
      typeof change.reason !== "string" || !change.reason.trim() || change.reason.length > 4000)
    throw Error("A bounded objective and revision reason are required");
  if (!Array.isArray(change.criteria) || !change.criteria.length || change.criteria.length > 100 ||
      change.criteria.some((item) => !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
        typeof item.description !== "string" || !item.description.trim() || item.description.length > 4000) ||
      new Set(change.criteria.map((item) => item.id)).size !== change.criteria.length)
    throw Error("Provide 1–100 distinct completion criteria with stable IDs and descriptions");
  if (JSON.stringify(change.criteria).length > 60000) throw Error("Completion criteria exceed 60,000 characters");
  const intent = { objective: change.objective.trim(),
    criteria: change.criteria.map(({ id, description }) => ({ id, description: description.trim() })),
    reason: change.reason.trim(), source: { ...source, step: run.step } };
  const last = previous?.versions.at(-1);
  if (change.expectedVersion === version - 1 && last &&
      JSON.stringify({ objective: last.objective, criteria: last.criteria, reason: last.reason, source: last.source }) === JSON.stringify(intent))
    return readContract(store, runId);
  if (change.expectedVersion !== version) throw Error("Contract version changed; read it again before revising");
  const next = { version: version + 1, parentVersion: version || null, ...intent, createdAt: now() };
  run.contract = {
    format: "browse.contract/v1", version: next.version, objective: next.objective,
    criteria: next.criteria.map((item) => {
      const existing = previous?.criteria.find((old) => old.id === item.id && old.description === item.description);
      return existing ? { ...existing } : { ...item, status: "pending" };
    }),
    versions: [...(previous?.versions || []), next],
  };
  store.tx(() => {
    store.saveRun(run);
    store.queue(`contracts/${run.id}/v${next.version}.json`, next);
    store.queue(`contracts/${run.id}/progress.json`, run.contract);
    store.event(run.id, "contract_revised", { ...contractProgress(run.contract), reason: next.reason });
    store.portableRun(run.id);
  });
  return readContract(store, runId);
}

export function recordCriterion(store, runId, entry) {
  const run = store.run(runId), contract = run.contract;
  if (!contract || entry.expectedVersion !== contract.version)
    throw Error("Read the current contract version before recording progress");
  const criterion = contract.criteria.find((item) => item.id === entry.criterionId);
  if (!criterion) throw Error("Unknown completion criterion");
  if (typeof entry.summary !== "string" || !entry.summary.trim() || entry.summary.length > 8000)
    throw Error("Explain how the evidence satisfies this criterion");
  const observationIds = [...new Set(entry.observationIds || [])];
  const artifactPaths = [...new Set(entry.artifactPaths || [])];
  if (!observationIds.length && !artifactPaths.length) throw Error("Completion requires saved observations or artifacts");
  const actions = store.actions(runId);
  for (const id of observationIds) {
    const observation = actions.find((action) => action.id === id);
    if (!observation || observation.effectful || observation.state !== "completed" ||
        !["read", "snapshot", "grep", "diff", "screenshot", "history", "tabs"].includes(observation.tool))
      throw Error("Evidence must reference completed read-only observations in this run");
  }
  const artifacts = store.records("artifact");
  for (const path of artifactPaths) {
    const artifact = artifacts.find((record) => record.body.path === path && record.body.runId === runId);
    if (!artifact || hash(fs.readFileSync(inside(store.p.checkout, path))) !== artifact.body.hash)
      throw Error("Evidence must reference an intact artifact produced by this run");
  }
  if (criterion.status === "completed") return readContract(store, runId);
  Object.assign(criterion, { status: "completed", evidence: {
    summary: entry.summary.trim(), observationIds, artifactPaths, version: contract.version, recordedAt: now(),
  } });
  store.tx(() => {
    store.saveRun(run);
    store.queue(`contracts/${run.id}/progress.json`, contract);
    store.event(run.id, "contract_progress", { ...contractProgress(contract), criterionId: criterion.id, description: criterion.description });
    store.portableRun(run.id);
  });
  return readContract(store, runId);
}
