// Dependency layers and dispatch order (§7); the per-stage state machine joins this file later. Pure functions, no I/O.

// B1 = no deps inside the batch; a dependency outside the batch counts as met. A cycle is named by its members.
export function layers(tasks) {
  const known = new Set(tasks.map((t) => t.issue));
  const deps = new Map(tasks.map((t) => [t.issue, t.deps.filter((d) => known.has(d))]));
  const batches = new Map();
  while (batches.size < deps.size) {
    const ready = [...deps].filter(([i, ds]) => !batches.has(i) && ds.every((d) => batches.has(d)));
    if (!ready.length) {
      // Every unplaced task has an unplaced dep, so walking deps must revisit one: that loop is the cycle.
      const seen = [];
      let at = [...deps.keys()].find((i) => !batches.has(i));
      while (!seen.includes(at)) { seen.push(at); at = deps.get(at).find((d) => !batches.has(d)); }
      return { cycle: seen.slice(seen.indexOf(at)).sort((a, b) => a - b) };
    }
    // A task lands one layer above its deepest dep. Placing this round's `ready` together is safe: none depends on another.
    for (const [i, ds] of ready) batches.set(i, Math.max(0, ...ds.map((d) => batches.get(d))) + 1);
  }
  return { batches };
}

// Queued or waiting, and every dep met: merged, or with no row in the batch (same rule as layers).
export function dispatchable(row, rowsByIssue, mergedIssues) {
  return (row.status === 'queued' || row.status === 'waiting')
    && row.deps.every((d) => mergedIssues.has(d) || !rowsByIssue.has(d) || rowsByIssue.get(d).status === 'merged');
}

// Lowest Batch first, then row order. Array.sort is stable, so ties keep the ledger's row order.
export const dispatchOrder = (rows) => [...rows].sort((a, b) => a.batch - b.batch);
