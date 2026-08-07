import { NextResponse } from "next/server";
import { SimplePool, verifyEvent, type Event } from "nostr-tools";
import type { EscrowCatalogEntry, NostrEvent } from "../../../lib/escrow";
import { validateEscrowDescriptor, validateEscrowService } from "../../../lib/escrow-server";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

export async function GET() {
  const relays = getRelays();
  const pool = new SimplePool();

  try {
    const events = await pool.querySync(relays, { kinds: [30361], limit: 100 }, { maxWait: 8000 });
    const latestEvents = latestAddressableEvents(events);
    const escrows = await Promise.all(latestEvents.map(toCatalogEntry));
    const rejected = escrows.filter((entry) => !entry.compatible).length;

    return NextResponse.json({ escrows, relays, rejected });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Escrow relay discovery failed.", relays },
      { status: 502 },
    );
  } finally {
    pool.destroy();
  }
}

async function toCatalogEntry(event: Event): Promise<EscrowCatalogEntry> {
  const source = { type: "nostr", event: event as NostrEvent } as const;
  const identifier = event.tags.find(([name]) => name === "d")?.[1] || event.id;
  let descriptor: unknown;

  try {
    descriptor = JSON.parse(event.content);
  } catch {
    return {
      source,
      publisher_pubkey: event.pubkey,
      identifier,
      compatible: false,
      compatibility_status: "standalone_incompatible",
      compatibility_reason: "Descriptor content is not valid JSON.",
    };
  }

  let validatedDescriptor;
  try {
    validatedDescriptor = validateEscrowDescriptor(descriptor);
  } catch (error) {
    return {
      descriptor: isRecord(descriptor) ? descriptor : undefined,
      source,
      publisher_pubkey: event.pubkey,
      identifier,
      compatible: false,
      compatibility_status: "standalone_incompatible",
      compatibility_reason: error instanceof Error ? error.message : "Descriptor is invalid.",
    };
  }

  if (!validatedDescriptor.service) {
    return {
      descriptor: validatedDescriptor,
      source,
      publisher_pubkey: event.pubkey,
      identifier,
      compatible: false,
      compatibility_status: "discovery_only",
      compatibility_reason: "PIP-01 descriptor is valid for compatibility and discovery only; it does not advertise a standalone service.",
    };
  }

  try {
    const service = await validateEscrowService(validatedDescriptor, source);
    return {
      service,
      descriptor: service.descriptor,
      source,
      publisher_pubkey: event.pubkey,
      identifier,
      compatible: true,
      compatibility_status: "standalone_compatible",
    };
  } catch (error) {
    return {
      descriptor: isRecord(descriptor) ? descriptor : undefined,
      source,
      publisher_pubkey: event.pubkey,
      identifier,
      compatible: false,
      compatibility_status: "standalone_incompatible",
      compatibility_reason: error instanceof Error ? error.message : "Descriptor is incompatible with Rollpot.",
    };
  }
}

function latestAddressableEvents(events: Event[]) {
  const latest = new Map<string, Event>();

  for (const event of events) {
    const identifier = event.tags.find(([name]) => name === "d")?.[1];
    if (!identifier || !verifyEvent(event)) continue;
    const key = `${event.pubkey}:${identifier}`;
    const current = latest.get(key);
    if (!current || event.created_at > current.created_at) latest.set(key, event);
  }

  return [...latest.values()];
}

function getRelays() {
  const configured = process.env.ESCROW_DISCOVERY_RELAYS?.split(",").map((relay) => relay.trim()).filter(Boolean);
  return configured?.length ? configured : DEFAULT_RELAYS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
