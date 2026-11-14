import { Badge, Empty, StatusBadge, when } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function AuditRows({ rows, showInput = false }: { rows: any[]; showInput?: boolean }) {
  if (!rows.length) return <Empty>No audit entries yet.</Empty>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th className="w-32">Time</th>
          <th>Actor</th>
          <th>Action</th>
          <th>Policy decision</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={String(r._id)}>
            <td className="whitespace-nowrap text-ink-faint">{when(r.ts)}</td>
            <td>
              <div className="flex items-center gap-1.5">
                <Badge tone={r.actor?.type === "agent" ? "blue" : r.actor?.type === "user" ? "green" : "gray"}>{r.actor?.type}</Badge>
                <span>{r.actor?.name}</span>
              </div>
              {r.onBehalfOf && <div className="mt-0.5 text-[11px] text-ink-faint">authority: {r.onBehalfOf.role} {String(r.onBehalfOf.userId).slice(-6)}</div>}
            </td>
            <td>
              <div className="mono">{r.action}</div>
              {r.reason && <div className="mt-0.5 max-w-md text-xs text-ink-soft">{r.reason}</div>}
              {showInput && r.input && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-ink-faint">input / output</summary>
                  <pre className="mono mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap rounded bg-stone-50 p-2">{JSON.stringify({ input: r.input, result: r.result?.detail }, null, 2)}</pre>
                </details>
              )}
            </td>
            <td>
              {r.decision ? (
                <div>
                  <StatusBadge status={r.decision} />
                  <div className="mono mt-0.5 text-ink-faint">{r.policyRule}{r.policyVersion ? ` · v${r.policyVersion}` : ""}</div>
                </div>
              ) : (
                <span className="text-ink-faint">—</span>
              )}
            </td>
            <td>
              <StatusBadge status={r.result?.status} />
              {r.result?.providerId && <div className="mono mt-0.5 text-ink-faint">{String(r.result.providerId).slice(0, 14)}…</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
