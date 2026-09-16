import { SimplePool, verifyEvent, type Event } from "nostr-tools";

const INVITE_KIND = 78;
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

function relays() {
  const configured = process.env.NOSTR_GAME_RELAYS?.split(",").map((relay) => relay.trim()).filter(Boolean);
  return configured?.length ? configured : DEFAULT_RELAYS;
}

function validInvite(event: Event) {
  const encoded = typeof event.content === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(event.content) ? Buffer.from(event.content, "base64") : null;
  return event.kind === INVITE_KIND && verifyEvent(event) &&
    event.tags.some((tag) => tag[0] === "p" && /^[0-9a-f]{64}$/.test(tag[1] || "")) &&
    event.tags.some((tag) => tag[0] === "d" && /^rollpot\/rematch\/v1:[a-zA-Z0-9_-]{1,128}$/.test(tag[1] || "")) &&
    encoded !== null && encoded.length >= 99 && encoded[0] === 2 && event.content.length <= 4096 &&
    event.created_at <= Math.floor(Date.now() / 1000) + 300;
}

function inviteEscrowId(event: Event) {
  const identifier = event.tags.find((tag) => tag[0] === "d")?.[1] || "";
  return identifier.startsWith("rollpot/rematch/v1:") ? identifier.slice("rollpot/rematch/v1:".length) : "";
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const recipient = query.get("recipient_pubkey") || "";
  const partnerPubkeys = [...new Set(query.getAll("partner_pubkey"))];
  const knownEscrowIds = new Set(query.getAll("known_escrow_id"));
  if (!/^[0-9a-f]{64}$/.test(recipient)) return Response.json({ error: "Invalid recipient pubkey." }, { status: 400 });
  if (partnerPubkeys.length > 100 || partnerPubkeys.some((pubkey) => !/^[0-9a-f]{64}$/.test(pubkey))) return Response.json({ error: "Invalid partner pubkeys." }, { status: 400 });
  if (knownEscrowIds.size > 100 || [...knownEscrowIds].some((escrowId) => !/^[a-zA-Z0-9_-]{1,128}$/.test(escrowId))) return Response.json({ error: "Invalid known escrow IDs." }, { status: 400 });
  if (!partnerPubkeys.length) return Response.json({ requests: [] }, { headers: { "Cache-Control": "no-store" } });
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays(), { kinds: [INVITE_KIND], authors: partnerPubkeys, "#p": [recipient], since: Math.floor(Date.now() / 1000) - 30 * 86400, limit: 100 }, { maxWait: 5000 });
    const requests = events.flatMap((event) => {
      const escrowId = inviteEscrowId(event);
      if (!validInvite(event) || !partnerPubkeys.includes(event.pubkey) || !event.tags.some((tag) => tag[0] === "p" && tag[1] === recipient) || !escrowId || knownEscrowIds.has(escrowId)) return [];
      return [{ event, sender_pubkey: event.pubkey, escrow_id: escrowId }];
    });
    return Response.json({ requests }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invite lookup failed." }, { status: 502 });
  } finally { pool.destroy(); }
}

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") || 0) > 8192) throw new Error("Invite is too large.");
    const event = (await request.json()).event as Event;
    if (!event || !validInvite(event)) throw new Error("Invalid signed encrypted invite.");
    const pool = new SimplePool();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const destinations = relays();
      const results = await Promise.race([
        Promise.allSettled(pool.publish(destinations, event)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Invite publication timed out.")), 8000); }),
      ]);
      if (!results.some((result) => result.status === "fulfilled")) throw new Error("No Nostr relay accepted the invite.");
      return Response.json({ event_id: event.id });
    } finally { if (timer) clearTimeout(timer); pool.destroy(); }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invite publication failed." }, { status: 400 });
  }
}
