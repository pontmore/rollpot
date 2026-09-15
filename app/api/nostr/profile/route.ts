import { SimplePool, verifyEvent, type Event } from "nostr-tools";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

function relays() {
  const configured = process.env.NOSTR_PROFILE_RELAYS?.split(",").map((relay) => relay.trim()).filter(Boolean);
  return configured?.length ? configured : DEFAULT_RELAYS;
}

export async function GET(request: Request) {
  const pubkey = new URL(request.url).searchParams.get("pubkey") || "";
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return Response.json({ error: "Invalid Nostr pubkey." }, { status: 400 });

  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays(), { kinds: [0], authors: [pubkey], limit: 10 }, { maxWait: 5000 });
    const latest = events.filter((event) => event.pubkey === pubkey && verifyEvent(event))
      .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))[0];
    if (!latest) return Response.json({ metadata: null }, { headers: { "Cache-Control": "no-store" } });

    const metadata = JSON.parse(latest.content) as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("Nostr profile metadata is not an object.");
    }
    return Response.json({ metadata, event_id: latest.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Profile lookup failed." }, { status: 502 });
  } finally {
    pool.destroy();
  }
}

export async function POST(request: Request) {
  let event: Event;
  try {
    if (Number(request.headers.get("content-length") || 0) > 16_384) throw new Error("Profile event is too large.");
    event = (await request.json()).event as Event;
    if (!event || event.kind !== 0 || !verifyEvent(event) || event.content.length > 8192) {
      throw new Error("Invalid signed Nostr profile event.");
    }
    const metadata = JSON.parse(event.content) as Record<string, unknown>;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || typeof metadata.name !== "string" || !metadata.name.trim()) {
      throw new Error("Nostr profile needs a name.");
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid profile event." }, { status: 400 });
  }

  const pool = new SimplePool();
  const destinations = relays();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const results = await Promise.race([
      Promise.allSettled(pool.publish(destinations, event)),
      new Promise<PromiseSettledResult<string>[]>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Nostr relay publication timed out.")), 8000);
      }),
    ]);
    const published = results.flatMap((result, index) => result.status === "fulfilled" ? [destinations[index]] : []);
    if (!published.length) throw new Error("No Nostr relay accepted the profile update.");
    return Response.json({ event_id: event.id, published });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Profile publication failed." }, { status: 502 });
  } finally {
    if (timeout) clearTimeout(timeout);
    pool.destroy();
  }
}
