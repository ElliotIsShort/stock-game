"use client";

import { useEffect, useState, type FormEvent } from "react";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import { CONFIG_BOUNDS, type AuditEntry, type GameConfig, type Registration } from "@fsm/shared";
import { useGame } from "@/components/GameProvider";
import { fb } from "@/lib/firebase";
import { useQuery } from "@/lib/hooks";
import { api, errorMessage } from "@/lib/api";
import { ago, gbp } from "@/lib/format";

export default function AdminPage() {
  const { isAdmin } = useGame();
  if (!isAdmin) return <p className="muted">Admins only.</p>;
  return (
    <div className="stack">
      <h1>Admin</h1>
      <Approvals />
      <WeeklyClose />
      <ConfigEditor />
      <Delist />
      <AuditLog />
    </div>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  const view = msg && <p className={msg.ok ? "success" : "error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>;
  return { busy, run, view };
}

function Approvals() {
  const pending = useQuery<Registration>(
    query(collection(fb().db, "registrations"), where("status", "==", "pending"), orderBy("createdAt", "asc")),
    [],
  );
  const { busy, run, view } = useAction();
  return (
    <section className="card">
      <h2>Pending sign-ups</h2>
      {pending.error && <p className="error">{pending.error.message}</p>}
      {pending.data.length === 0 && <p className="muted">No one waiting.</p>}
      <ul className="plain">
        {pending.data.map((r) => (
          <li key={r.uid} className="row between wrap">
            <span>
              <strong>{r.displayName}</strong> <span className="muted small">{r.email ?? "no email"} · {ago(r.createdAt)}</span>
            </span>
            <span className="row">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const res = await api.approvePlayer(r.uid);
                    return `Approved ${r.displayName}: ${gbp(res.startingCash)} cash, listed at ${gbp(res.listingPrice)}.`;
                  })
                }
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Decline ${r.displayName}'s request?`)) return;
                  run(async () => {
                    await api.rejectPlayer(r.uid);
                    return `Declined ${r.displayName}.`;
                  });
                }}
              >
                Decline
              </button>
            </span>
          </li>
        ))}
      </ul>
      {view}
    </section>
  );
}

function WeeklyClose() {
  const { state } = useGame();
  const { busy, run, view } = useAction();
  const week = state?.currentWeek ?? 1;
  return (
    <section className="card">
      <h2>Weekly close</h2>
      <p className="muted small">
        Snapshots balances, pays allowances and CEO bonuses, tops up pools, pays the {gbp(state?.prizePool ?? 0)} prize pool to the top
        weekly grower and stores the report. {state?.lastCloseAt ? `Last close ${ago(state.lastCloseAt)}.` : "Never closed."}
      </p>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => {
          if (!window.confirm(`Close week ${week} now? This pays out money and can't be undone.`)) return;
          run(async () => {
            const res = await api.runWeeklyClose(week);
            if (!res.closed) return `Skipped: ${res.reason}`;
            return `Week ${res.week} closed. ${res.winner ? `${res.winner} won ${gbp(res.prize ?? 0)}.` : "No winner."}`;
          });
        }}
      >
        Close week {week}
      </button>
      {view}
    </section>
  );
}

function ConfigEditor() {
  const { config } = useGame();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { busy, run, view } = useAction();

  useEffect(() => {
    setDraft(Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)])));
  }, [config]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const patch: Partial<GameConfig> = {};
    for (const key of Object.keys(CONFIG_BOUNDS) as (keyof GameConfig)[]) {
      const v = Number(draft[key]);
      if (draft[key] !== undefined && v !== config[key]) patch[key] = v;
    }
    if (Object.keys(patch).length === 0) return;
    run(async () => {
      await api.updateConfig(patch);
      return `Saved ${Object.keys(patch).join(", ")}.`;
    });
  }

  return (
    <section className="card">
      <h2>Settings</h2>
      <p className="muted small">Changes apply immediately to new trades and to the next weekly close. Every change is audit-logged.</p>
      <form onSubmit={submit} className="config-grid">
        {(Object.keys(CONFIG_BOUNDS) as (keyof GameConfig)[]).map((key) => {
          const b = CONFIG_BOUNDS[key];
          return (
            <label key={key}>
              {b.label}
              <input
                type="number"
                step={b.integer ? 1 : "any"}
                min={b.min}
                max={b.max}
                value={draft[key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                aria-describedby={`help-${key}`}
              />
              <span id={`help-${key}`} className="muted small">{b.help}</span>
            </label>
          );
        })}
        <button type="submit" className="primary" disabled={busy}>Save settings</button>
      </form>
      {view}
    </section>
  );
}

function Delist() {
  const { players } = useGame();
  const [uid, setUid] = useState("");
  const { busy, run, view } = useAction();
  const active = players.filter((p) => p.isActive).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const target = active.find((p) => p.uid === uid);
  return (
    <section className="card">
      <h2>Delist a player</h2>
      <p className="muted small">
        Only for someone who wants out entirely. Every holder is paid out at the last price, the stock is removed and the account is
        deactivated. Idle players don&apos;t need this.
      </p>
      <div className="row wrap">
        <label className="inline">
          Player{" "}
          <select value={uid} onChange={(e) => setUid(e.target.value)}>
            <option value="">Choose…</option>
            {active.map((p) => <option key={p.uid} value={p.uid}>{p.displayName}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="danger"
          disabled={busy || !target}
          onClick={() => {
            if (!target) return;
            const typed = window.prompt(`This can't be undone. Type "${target.displayName}" to delist them.`);
            if (typed !== target.displayName) return;
            run(async () => {
              const res = await api.delistPlayer(target.uid);
              setUid("");
              return `Delisted ${target.displayName}; paid ${res.payouts.length} holder(s).`;
            });
          }}
        >
          Delist
        </button>
      </div>
      {view}
    </section>
  );
}

function AuditLog() {
  const log = useQuery<AuditEntry>(query(collection(fb().db, "auditLog"), orderBy("createdAt", "desc"), limit(50)), []);
  const { playerById } = useGame();
  return (
    <section className="card">
      <h2>Audit log</h2>
      {log.data.length === 0 && <p className="muted">No admin actions yet.</p>}
      <ul className="plain audit">
        {log.data.map((e, i) => (
          <li key={i}>
            <span className="muted small">{new Date(e.createdAt).toLocaleString("en-GB")}</span>{" "}
            <strong>{playerById.get(e.actorId)?.displayName ?? e.actorId}</strong> {e.action}
            {e.targetId && <> → {playerById.get(e.targetId)?.displayName ?? e.targetId}</>}
            <details>
              <summary className="small">Details</summary>
              <pre>{JSON.stringify(e.details, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
