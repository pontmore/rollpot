import { SimplePool, type Event } from "nostr-tools";
import { GAME_ACTION_KIND, GAME_ROOT_KIND, gameEscrowTag, validateGameRecordEvent } from "../../../../lib/game-record";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
function relays() { const configured = process.env.NOSTR_GAME_RELAYS?.split(",").map((relay) => relay.trim()).filter(Boolean); return configured?.length ? configured : DEFAULT_RELAYS; }
function marker(event: Event, value: string) { return event.tags.find((tag) => tag[0] === "e" && tag[3] === value)?.[1] || ""; }
function rootEscrowId(event: Event) { try { return String(JSON.parse(event.content).terms?.escrow_id || ""); } catch { return ""; } }

async function assertCurrentTip(pool: SimplePool, event: Event, journalEvents: Event[]) {
  const destinations = relays();
  if (event.kind === GAME_ROOT_KIND) {
    const escrowId = rootEscrowId(event); const escrowTag = gameEscrowTag(escrowId);
    const existing = await pool.querySync(destinations, { kinds: [GAME_ROOT_KIND], "#t": [escrowTag], limit: 20 }, { maxWait: 3000 });
    if (existing.some((candidate) => { try { validateGameRecordEvent(candidate); return candidate.id !== event.id && rootEscrowId(candidate) === escrowId; } catch { return false; } })) throw new Error("This escrow already has a different coordination root.");
    return;
  }
  const rootId = marker(event, "root"); const predecessorId = marker(event, "prev");
  const [relayRoots, relayActions] = await Promise.all([
    pool.querySync(destinations, { kinds: [GAME_ROOT_KIND], ids: [rootId], limit: 1 }, { maxWait: 3000 }),
    pool.querySync(destinations, { kinds: [GAME_ACTION_KIND], "#e": [rootId], limit: 500 }, { maxWait: 3000 }),
  ]);
  const suppliedRoots = journalEvents.filter((candidate) => candidate.kind === GAME_ROOT_KIND && candidate.id === rootId);
  const suppliedActions = journalEvents.filter((candidate) => candidate.kind === GAME_ACTION_KIND && marker(candidate, "root") === rootId);
  const roots = [...new Map([...relayRoots, ...suppliedRoots].map((candidate) => [candidate.id, candidate])).values()];
  const actions = [...new Map([...relayActions, ...suppliedActions].map((candidate) => [candidate.id, candidate])).values()];
  const root = roots.find((candidate) => candidate.id === rootId); if (!root) throw new Error("The coordination root is not available on the relays yet.");
  const valid = actions.filter((candidate) => { try { validateGameRecordEvent(candidate); return marker(candidate, "root") === rootId; } catch { return false; } });
  if (valid.some((candidate) => candidate.id === event.id)) return;
  let tip = root.id;
  for (;;) {
    const children = valid.filter((candidate) => marker(candidate, "prev") === tip);
    if (children.length > 1) throw new Error("The coordination is forked and cannot progress.");
    if (!children.length) break;
    tip = children[0].id;
  }
  if (predecessorId !== tip) throw new Error("The coordination event does not reference the current chain tip.");
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams; const escrowId = query.get("escrow_id") || ""; const requestedRoot = query.get("root_id") || "";
  if (requestedRoot && !/^[0-9a-f]{64}$/.test(requestedRoot)) return Response.json({ error: "Invalid coordination root ID." }, { status: 400 });
  let escrowTag: string; try { escrowTag = gameEscrowTag(escrowId); } catch { return Response.json({ error: "Invalid escrow ID." }, { status: 400 }); }
  const pool = new SimplePool();
  try {
    const [taggedRoots, exactRoot] = await Promise.all([
      pool.querySync(relays(), { kinds: [GAME_ROOT_KIND], "#t": [escrowTag], limit: 20 }, { maxWait: 5000 }),
      requestedRoot ? pool.querySync(relays(), { kinds: [GAME_ROOT_KIND], ids: [requestedRoot], limit: 1 }, { maxWait: 5000 }) : Promise.resolve([] as Event[]),
    ]);
    const roots = [...new Map([...taggedRoots, ...exactRoot].map((event) => [event.id, event])).values()].filter((event) => { try { validateGameRecordEvent(event); return JSON.parse(event.content).terms?.escrow_id === escrowId; } catch { return false; } });
    const actions = roots.length ? await pool.querySync(relays(), { kinds: [GAME_ACTION_KIND], "#e": roots.map((root) => root.id), limit: 500 }, { maxWait: 5000 }) : [];
    return Response.json({ events: [...roots, ...actions.filter((event) => { try { validateGameRecordEvent(event); return true; } catch { return false; } })] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Coordination lookup failed." }, { status: 502 }); }
  finally { pool.destroy(); }
}

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") || 0) > 256 * 1024) throw new Error("Coordination request is too large.");
    const body = await request.json() as { event?: Event; journal_events?: Event[] };
    const event = body.event as Event;
    const journalEvents = body.journal_events || [];
    if (!event || !Array.isArray(journalEvents) || journalEvents.length > 256) throw new Error("Invalid coordination request.");
    validateGameRecordEvent(event);
    journalEvents.forEach(validateGameRecordEvent);
    const pool = new SimplePool(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assertCurrentTip(pool, event, journalEvents);
      const destinations = relays();
      const results = await Promise.race([Promise.allSettled(pool.publish(destinations, event)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Coordination publication timed out.")), 8000); })]);
      if (!results.some((result) => result.status === "fulfilled")) throw new Error("No Nostr relay accepted the coordination event.");
      return Response.json({ event_id: event.id });
    } finally { if (timer) clearTimeout(timer); pool.destroy(); }
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Coordination publication failed." }, { status: 400 }); }
}
