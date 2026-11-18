"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { collection, orderBy, query, where } from "firebase/firestore";
import { closeTimeError, formatCloseTime, type Registration, type ServerDoc } from "@fsm/shared";
import { api } from "@/lib/api";
import { fb } from "@/lib/firebase";
import { ago, gbp } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { useAction } from "@/lib/useAction";
import { useGame } from "../GameProvider";

/**
 * Admin-only server tools. This is the only UI that mentions servers, apart
 * from the account menu / picker shown to people in two or more of them.
 */

/** All servers (admins may list the collection). Newest first. */
export function useServers(): { servers: ServerDoc[]; loading: boolean } {
  const q = useQuery<ServerDoc>(query(collection(fb().db, "servers"), orderBy("createdAt", "desc")), []);
  return { servers: q.data, loading: q.loading };
}

const labelOf = (s: ServerDoc) => `${s.name} (${s.slug})${s.status === "archived" ? " · archived" : ""}`;

/** Scopes everything below it on the Admin page to one server (it sets `?s=`). */
export function ServerSelector() {
  const { servers } = useServers();
  const { serverId, switchServer } = useGame();
  if (servers.length === 0) return null;
  return (
    <section className="card row wrap" aria-label="Server">
      <label className="inline">
        <strong>Server</strong>{" "}
        <select value={serverId ?? ""} onChange={(e) => e.target.value && switchServer(e.target.value)}>
          {!serverId && <option value="">Choose a server…</option>}
          {servers.map((s) => <option key={s.slug} value={s.slug}>{labelOf(s)}</option>)}
        </select>
      </label>
      <span className="muted small">Players, weekly close, settings, rules, delist, audit, reset, Discord and “View as player” below apply to this server.</span>
    </section>
  );
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type ConfigChoice = "default" | "copy" | null;

/** Create, rename, archive/unarchive servers and set their Discord webhook. */
export function ServersPanel() {
  const { servers } = useServers();
  const { switchServer } = useGame();
  const create = useAction();
  const [name, setName] = useState("");
  const [closes, setCloses] = useState(() => toLocalInput(Date.now() + 7 * 86_400_000));
  // No default: the owner chooses between the two options every time.
  const [choice, setChoice] = useState<ConfigChoice>(null);
  const [copyFrom, setCopyFrom] = useState("");
  const [created, setCreated] = useState<{ serverId: string; name: string } | null>(null);

  const picked = closes ? new Date(closes).getTime() : Number.NaN;
  const timeProblem = closes ? closeTimeError(picked, Date.now()) : null;
  const ready = name.trim().length >= 2 && Number.isFinite(picked) && !timeProblem && (choice === "default" || (choice === "copy" && copyFrom !== ""));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    create.run(async () => {
      const res = await api.createServer({ name: name.trim(), closesAt: picked, ...(choice === "copy" ? { copyConfigFrom: copyFrom } : {}) });
      setCreated(res);
      setName("");
      setChoice(null);
      setCopyFrom("");
      return `Created “${res.name}”.`;
    });
  }

  return (
    <section className="card stack">
      <h2>Servers</h2>
      <p className="muted small">
        Each server is a separate game for its own group: nothing crosses between them. Its code is generated for you and never changes; the name can be edited.
      </p>
      {servers.length === 0 && <p className="muted">No servers yet. Create the first one below.</p>}
      <ul className="plain stack">
        {servers.map((s) => <ServerRow key={s.slug} server={s} onOpen={() => switchServer(s.slug)} />)}
      </ul>

      <form className="stack" onSubmit={submit}>
        <h3>Create a server</h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={40} required />
        </label>
        <label>
          First close time (your timezone: {zone})
          <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} required aria-invalid={timeProblem ? true : undefined} />
        </label>
        <p className={timeProblem ? "error small" : "muted small"} aria-live="polite">
          {timeProblem ?? (Number.isFinite(picked) ? `That's ${formatCloseTime(picked)} in UK time (Europe/London).` : "")}
        </p>
        <fieldset className="stack">
          <legend>Settings</legend>
          <label className="inline">
            <input type="radio" name="config-choice" checked={choice === "default"} onChange={() => setChoice("default")} style={{ width: "auto" }} />{" "}
            Start from the default settings
          </label>
          <label className="inline">
            <input type="radio" name="config-choice" checked={choice === "copy"} onChange={() => setChoice("copy")} disabled={servers.length === 0} style={{ width: "auto" }} />{" "}
            Copy settings from an existing server
          </label>
          {choice === "copy" && (
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} aria-label="Copy settings from" required>
              <option value="">Choose a server…</option>
              {servers.map((s) => <option key={s.slug} value={s.slug}>{labelOf(s)}</option>)}
            </select>
          )}
        </fieldset>
        <div>
          <button type="submit" className="primary" disabled={create.busy || !ready}>Create server</button>
        </div>
        {created && (
          <p className="success" role="status">
            Server code for “{created.name}”: <strong>{created.serverId}</strong>. Next: set its Discord webhook, then approve or add players into it.
          </p>
        )}
        {create.view}
      </form>
    </section>
  );
}

function ServerRow({ server, onOpen }: { server: ServerDoc; onOpen: () => void }) {
  const { busy, run, view } = useAction();
  const [editingHook, setEditingHook] = useState(false);
  const [hook, setHook] = useState("");
  const archived = server.status === "archived";
  return (
    <li className="stack server-row">
      <div className="row between wrap">
        <span>
          <strong>{server.name}</strong> <span className="muted small">code {server.slug} · {archived ? "archived (read-only)" : "active"} · closes {formatCloseTime(server.closesAt)} UK</span>
        </span>
        <span className="muted small">Discord webhook: <strong>{server.hasDiscordWebhook ? "set" : "not set"}</strong></span>
      </div>
      <div className="row wrap">
        <button type="button" onClick={onOpen}>Open</button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const next = window.prompt("New display name:", server.name);
            if (!next || next.trim() === server.name) return;
            run(async () => {
              const res = await api.renameServer(server.slug, next.trim());
              return `Renamed “${res.from}” to “${res.to}”.`;
            });
          }}
        >
          Rename
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!archived && !window.confirm(`Archive “${server.name}”? It becomes read-only: no trades, posts or weekly closes, and nothing posts to Discord.`)) return;
            run(async () => {
              if (archived) await api.unarchiveServer(server.slug);
              else await api.archiveServer(server.slug);
              return archived ? "Unarchived." : "Archived.";
            });
          }}
        >
          {archived ? "Unarchive" : "Archive"}
        </button>
        <button type="button" disabled={busy} onClick={() => setEditingHook((v) => !v)}>
          {server.hasDiscordWebhook ? "Change webhook" : "Set webhook"}
        </button>
      </div>
      {editingHook && (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const res = await api.setDiscordWebhook(server.slug, hook);
              setHook("");
              setEditingHook(false);
              return res.set ? "Webhook saved." : "Webhook cleared.";
            });
          }}
        >
          <label className="inline">
            Webhook URL{" "}
            <input type="password" autoComplete="off" value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://discord.com/api/webhooks/…" />
          </label>
          <button type="submit" className="primary" disabled={busy}>{hook.trim() ? "Save" : "Clear webhook"}</button>
          <span className="muted small">Write-only: it can never be read back, only replaced or cleared.</span>
        </form>
      )}
      {view}
    </li>
  );
}

/** Pending sign-ups across all servers, each approved INTO a chosen server. */
export function Approvals() {
  const pending = useQuery<Registration>(
    query(collection(fb().db, "registrations"), where("status", "==", "pending"), orderBy("createdAt", "asc")),
    [],
  );
  const { servers } = useServers();
  const active = useMemo(() => servers.filter((s) => s.status === "active"), [servers]);
  const { serverId } = useGame();
  const [target, setTarget] = useState<Record<string, string>>({});
  const { busy, run, view } = useAction();
  const fallback = active.find((s) => s.slug === serverId)?.slug ?? active[0]?.slug ?? "";
  const pick = (uid: string) => target[uid] ?? fallback;
  return (
    <section className="card">
      <h2>Pending sign-ups</h2>
      {pending.error && <p className="error">{pending.error.message}</p>}
      {pending.data.length === 0 && <p className="muted">No one waiting.</p>}
      {pending.data.length > 0 && active.length === 0 && <p className="error">Create a server first: people are approved into one.</p>}
      <ul className="plain">
        {pending.data.map((r) => {
          const chosen = active.find((s) => s.slug === pick(r.uid));
          return (
            <li key={r.uid} className="row between wrap">
              <span>
                <strong>{r.displayName}</strong> <span className="muted small">{r.email ?? "no email"} · {ago(r.createdAt)}</span>
              </span>
              <span className="row wrap">
                <label className="inline">
                  <span className="sr-only">Server for {r.displayName}</span>
                  <select value={pick(r.uid)} onChange={(e) => setTarget({ ...target, [r.uid]: e.target.value })} disabled={active.length === 0}>
                    {active.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
                  </select>
                </label>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !chosen}
                  onClick={() =>
                    chosen &&
                    run(async () => {
                      const res = await api.approvePlayer(r.uid, chosen.slug);
                      return `Approved ${r.displayName} into ${chosen.name}: ${gbp(res.startingCash)} cash, listed at ${gbp(res.listingPrice)}.`;
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
          );
        })}
      </ul>
      {view}
    </section>
  );
}

/** Put an already-approved user into another server (a separate player, cash, stock and ticker there). */
export function AddExistingUser() {
  const approved = useQuery<Registration>(query(collection(fb().db, "registrations"), where("status", "==", "approved")), []);
  const { servers } = useServers();
  const active = useMemo(() => servers.filter((s) => s.status === "active"), [servers]);
  const { serverId } = useGame();
  const [uid, setUid] = useState("");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const { busy, run, view } = useAction();
  useEffect(() => {
    if (!target && active.length) setTarget(active.find((s) => s.slug === serverId)?.slug ?? active[0].slug);
  }, [active, serverId, target]);
  const people = [...approved.data].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const chosen = people.find((p) => p.uid === uid);
  const server = active.find((s) => s.slug === target);
  return (
    <section className="card stack">
      <h2>Add an existing user to a server</h2>
      <p className="muted small">
        For someone who already plays and should also join another server (for example you, in a second one). They get a fresh player, cash, stock and ticker there,
        and can use a different display name.
      </p>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen || !server) return;
          run(async () => {
            const res = await api.addPlayerToServer(chosen.uid, server.slug, name.trim() || undefined);
            setUid("");
            setName("");
            return `Added ${chosen.displayName} to ${server.name}: ${gbp(res.startingCash)} cash, listed at ${gbp(res.listingPrice)}.`;
          });
        }}
      >
        <label className="inline">
          User{" "}
          <select value={uid} onChange={(e) => setUid(e.target.value)} required>
            <option value="">Choose…</option>
            {people.map((p) => <option key={p.uid} value={p.uid}>{p.displayName}{p.email ? ` (${p.email})` : ""}</option>)}
          </select>
        </label>
        <label className="inline">
          Server{" "}
          <select value={target} onChange={(e) => setTarget(e.target.value)} required>
            {active.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
          </select>
        </label>
        <label className="inline">
          Display name there{" "}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.displayName ?? "same as registered"} maxLength={30} />
        </label>
        <button type="submit" className="primary" disabled={busy || !chosen || !server}>Add to server</button>
      </form>
      {view}
    </section>
  );
}
