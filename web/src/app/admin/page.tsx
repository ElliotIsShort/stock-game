"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import { doc } from "firebase/firestore";
import {
  CONFIG_BOUNDS,
  DEFAULT_CHANGELOG,
  DEFAULT_RULES,
  prizeSplitText,
  type AuditEntry,
  type Bound,
  type GameConfig,
  type Registration,
  type SiteContent,
} from "@fsm/shared";
import { useGame } from "@/components/GameProvider";
import { fb } from "@/lib/firebase";
import { useDoc, useQuery } from "@/lib/hooks";
import { api, errorMessage } from "@/lib/api";
import { ago, gbp } from "@/lib/format";

export default function AdminPage() {
  const { isAdmin, setPreviewAsPlayer } = useGame();
  const router = useRouter();
  if (!isAdmin) return <p className="muted">Admins only.</p>;
  return (
    <div className="stack">
      <div className="row between wrap">
        <h1>Admin</h1>
        <button
          type="button"
          title="Hide admin tools and browse as a player. Undo from the banner or the account menu."
          onClick={() => {
            setPreviewAsPlayer(true);
            router.push("/");
          }}
        >
          View as player
        </button>
      </div>
      <Approvals />
      <Players />
      <WeeklyClose />
      <ConfigEditor />
      <ContentEditor />
      <Delist />
      <AuditLog />
      <ResetGame />
    </div>
  );
}

/** Player roster: last online, idle/bankrupt status, and rename. */
function Players() {
  const { players, stockById, tickerOf } = useGame();
  const { busy, run, view } = useAction();
  const roster = [...players].sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  function retick(uid: string, name: string) {
    const current = tickerOf(uid);
    const next = window.prompt(`New ticker for ${name} (2–5 letters):`, current);
    if (!next || next.trim().toUpperCase() === current) return;
    run(async () => {
      const res = await api.setTicker(next.trim(), uid);
      return `${name} now trades as $${res.ticker}.`;
    });
  }

  function rename(uid: string, current: string) {
    const next = window.prompt(`New name for ${current}:`, current);
    if (!next || next.trim() === current) return;
    run(async () => {
      const res = await api.renamePlayer(uid, next.trim());
      return `Renamed ${res.from} to ${res.to}.`;
    });
  }

  return (
    <section className="card">
      <h2>Players</h2>
      {roster.length === 0 && <p className="muted">No players yet.</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Last online</th>
              <th scope="col">Status</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {roster.map((p) => (
              <tr key={p.uid} className={p.isIdle ? "idle" : undefined}>
                <th scope="row">{p.displayName}</th>
                <td title={new Date(p.lastActiveAt).toLocaleString("en-GB")}>{ago(p.lastActiveAt)}</td>
                <td className="muted small">
                  {!p.isActive ? "deactivated" : p.isIdle ? "idle" : "active"}
                </td>
                <td className="row">
                  <button type="button" className="link small" disabled={busy} onClick={() => rename(p.uid, p.displayName)}>Rename</button>
                  {stockById.has(p.uid) && (
                    <button type="button" className="link small" disabled={busy} onClick={() => retick(p.uid, p.displayName)}>
                      Ticker (${tickerOf(p.uid)})
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view}
    </section>
  );
}

/** Edit the Rules and Change log pages shown to players. */
function ContentEditor() {
  const content = useDoc<SiteContent>(doc(fb().db, "content", "global"), []);
  const [rules, setRules] = useState<string | null>(null);
  const [changelog, setChangelog] = useState<string | null>(null);
  const { busy, run, view } = useAction();

  // Seed the editors once content loads (or fall back to the defaults).
  useEffect(() => {
    if (content.loading) return;
    setRules((r) => (r === null ? content.data?.rules ?? DEFAULT_RULES : r));
    setChangelog((c) => (c === null ? content.data?.changelog ?? DEFAULT_CHANGELOG : c));
  }, [content.loading, content.data]);

  return (
    <section className="card">
      <h2>Rules &amp; change log</h2>
      <p className="muted small">
        Shown on the Rules and Change log pages. Use <code># Heading</code>, <code>## Subheading</code> and <code>- bullet</code> lines.
      </p>
      <label>
        Rules
        <textarea rows={10} value={rules ?? ""} onChange={(e) => setRules(e.target.value)} />
      </label>
      <label>
        Change log
        <textarea rows={10} value={changelog ?? ""} onChange={(e) => setChangelog(e.target.value)} />
      </label>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const patch: { rules?: string; changelog?: string } = {};
            if (rules !== null && rules !== (content.data?.rules ?? DEFAULT_RULES)) patch.rules = rules;
            if (changelog !== null && changelog !== (content.data?.changelog ?? DEFAULT_CHANGELOG)) patch.changelog = changelog;
            if (!patch.rules && !patch.changelog) return "No changes to save.";
            await api.updateContent(patch);
            return `Saved ${Object.keys(patch).join(" & ")}.`;
          })
        }
      >
        Save content
      </button>
      {view}
    </section>
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
  const { state, config } = useGame();
  const { busy, run, view } = useAction();
  const week = state?.currentWeek ?? 1;
  return (
    <section className="card">
      <h2>Weekly close</h2>
      <p className="muted small">
        Snapshots balances, pays allowances and CEO bonuses, tops up pools, splits the {gbp(state?.prizePool ?? 0)} prize pool among the
        top weekly growers ({prizeSplitText(config.prizeSplitPct)}) and stores the report.{" "}
        {state?.lastCloseAt ? `Last close ${ago(state.lastCloseAt)}.` : "Never closed."}
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
            const winners = res.winners ?? [];
            return `Week ${res.week} closed. ${
              winners.length ? `Prize: ${winners.map((w) => `${w.name} ${gbp(w.prizeAmount)}`).join(", ")}.` : "No winner; the prize pool rolls over."
            }`;
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
    setDraft(Object.fromEntries(Object.entries(config).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])));
  }, [config]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const patch: Record<string, number | number[]> = {};
    for (const key of Object.keys(CONFIG_BOUNDS) as (keyof GameConfig)[]) {
      const raw = draft[key];
      if (raw === undefined) continue;
      const b: Bound = CONFIG_BOUNDS[key];
      const current = config[key];
      if (b.kind === "list") {
        // Blank pieces (e.g. a trailing comma) are dropped; anything non-numeric becomes NaN and the server rejects it.
        const list = raw.split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number);
        const prev = Array.isArray(current) ? current : [];
        if (list.length !== prev.length || list.some((v, i) => v !== prev[i])) patch[key] = list;
      } else {
        const v = Number(raw);
        if (v !== current) patch[key] = v;
      }
    }
    if (Object.keys(patch).length === 0) return;
    run(async () => {
      await api.updateConfig(patch as Partial<GameConfig>);
      return `Saved ${Object.keys(patch).join(", ")}.`;
    });
  }

  return (
    <section className="card">
      <h2>Settings</h2>
      <p className="muted small">Changes apply immediately to new trades and to the next weekly close. Every change is audit-logged.</p>
      <form onSubmit={submit} className="config-grid">
        {(Object.keys(CONFIG_BOUNDS) as (keyof GameConfig)[]).map((key) => {
          const b: Bound = CONFIG_BOUNDS[key];
          const onChange = (value: string) => setDraft({ ...draft, [key]: value });
          return (
            <label key={key}>
              {b.label}
              {b.kind === "list" ? (
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft[key] ?? ""}
                  onChange={(e) => onChange(e.target.value)}
                  aria-describedby={`help-${key}`}
                />
              ) : (
                <input
                  type="number"
                  step={b.integer ? 1 : "any"}
                  min={b.min}
                  max={b.max}
                  value={draft[key] ?? ""}
                  onChange={(e) => onChange(e.target.value)}
                  aria-describedby={`help-${key}`}
                />
              )}
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

function ResetGame() {
  const [typed, setTyped] = useState("");
  const { busy, run, view } = useAction();
  const ready = typed === "RESET";
  return (
    <section className="card danger-zone">
      <h2>Reset the game</h2>
      <p className="muted small">
        Puts the market back to day one: deletes every player, stock, holding, trade, post, photo and weekly report, and restarts at
        week 1 with an empty prize pool. Sign-in accounts, admins, settings and this audit log are kept. Everyone who was playing goes
        back to <strong>Pending sign-ups</strong> above, so you just re-approve them and they start fresh with founder cash.
      </p>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || !window.confirm("Really wipe all game data? This can't be undone.")) return;
          run(async () => {
            const res = await api.resetGame(typed);
            setTyped("");
            const total = Object.values(res.deleted).reduce((a, b) => a + b, 0);
            return `Reset done. Deleted ${total} document(s); ${res.requeued} player(s) are waiting for re-approval.`;
          });
        }}
      >
        <label className="inline">
          Type RESET to confirm{" "}
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-describedby="reset-help" />
        </label>
        <button type="submit" className="danger" disabled={busy || !ready}>
          {busy ? "Resetting…" : "Reset everything"}
        </button>
      </form>
      <p id="reset-help" className="muted small">Avoid running this while people are trading.</p>
      {view}
    </section>
  );
}
