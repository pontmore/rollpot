import "server-only";

import { SimplePool, verifyEvent, type Event as NostrEvent } from "nostr-tools";
import type { EscrowDescriptorSource, EscrowService } from "./escrow";
import { discoverEscrowService, validateEscrowService } from "./escrow-server";

const URL_SERVICE_CACHE_MS = 30_000;
const COORDINATE_CACHE_MS = 30_000;
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
type UrlServiceCache = Map<string, { expiresAt: number; service: Promise<EscrowService> }>;
type CoordinateServiceCache = Map<string, { expiresAt: number; service: Promise<EscrowService> }>;
const backend = globalThis as typeof globalThis & { __rollpotValidatedUrlServices?: UrlServiceCache; __rollpotCoordinateServices?: CoordinateServiceCache };
const validatedUrlServices = backend.__rollpotValidatedUrlServices ??= new Map();
const coordinateServices = backend.__rollpotCoordinateServices ??= new Map();

export async function discoverConfiguredEscrow(): Promise<EscrowService> {
  const coordinate = process.env.ROLLPOT_DEFAULT_ESCROW_COORDINATE?.trim() || "";
  if (!coordinate) throw new Error("ROLLPOT_DEFAULT_ESCROW_COORDINATE is not configured.");
  const cached = coordinateServices.get(coordinate);
  if (cached && cached.expiresAt > Date.now()) return cached.service;
  const service = discoverEscrowCoordinate(coordinate);
  coordinateServices.set(coordinate, { expiresAt: Date.now() + COORDINATE_CACHE_MS, service });
  try { return await service; }
  catch (error) { if (coordinateServices.get(coordinate)?.service === service) coordinateServices.delete(coordinate); throw error; }
}

export async function discoverEscrowCoordinate(coordinate: string): Promise<EscrowService> {
  const match = /^30361:([0-9a-f]{64}):(.{1,512})$/.exec(coordinate);
  if (!match) throw new Error("Escrow coordinate must be 30361:<publisher-pubkey>:<d-tag>.");
  const [, publisher, identifier] = match;
  const configured = process.env.ESCROW_DISCOVERY_RELAYS?.split(",").map((relay) => relay.trim()).filter(Boolean);
  const relays = configured?.length ? configured : DEFAULT_RELAYS;
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays, { kinds: [30361], authors: [publisher], "#d": [identifier], limit: 20 }, { maxWait: 8000 });
    const current = events.filter((event) => verifyEvent(event) && event.pubkey === publisher && event.tags.some(([name, value]) => name === "d" && value === identifier))
      .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))[0];
    if (!current) throw new Error(`No signed escrow descriptor was found for ${coordinate}.`);
    return discoverSource({ type: "nostr", event: current });
  } finally { pool.destroy(); }
}

export async function discoverSource(source: EscrowDescriptorSource | undefined) {
  if (!source) throw new Error("Missing escrow descriptor source.");
  if (source.type === "url") {
    // A direct descriptor may change, so cache validated service discovery only
    // long enough to share it between adjacent UI and proxy requests.
    const cached = validatedUrlServices.get(source.url);
    if (cached && cached.expiresAt > Date.now()) return cached.service;

    const service = discoverEscrowService(source.url);
    validatedUrlServices.set(source.url, { expiresAt: Date.now() + URL_SERVICE_CACHE_MS, service });
    if (validatedUrlServices.size > 32) {
      validatedUrlServices.delete(validatedUrlServices.keys().next().value!);
    }
    try {
      return await service;
    } catch (error) {
      if (validatedUrlServices.get(source.url)?.service === service) validatedUrlServices.delete(source.url);
      throw error;
    }
  }
  if (
    source.event.kind !== 30361 ||
    !source.event.tags.some(([name, value]) => name === "d" && Boolean(value)) ||
    !verifyEvent(source.event as NostrEvent)
  ) {
    throw new Error("Invalid escrow descriptor event.");
  }
  return validateEscrowService(JSON.parse(source.event.content), source);
}

export function validateNip98Authorization(authorization: string, upstreamUrl: string) {
  try {
    const encodedEvent = authorization.slice("Nostr ".length);
    const event = JSON.parse(Buffer.from(encodedEvent, "base64").toString("utf8")) as NostrEvent;
    const urlTag = event.tags.find(([name]) => name === "u")?.[1];
    const methodTag = event.tags.find(([name]) => name === "method")?.[1];

    if (
      event.kind !== 27235 ||
      urlTag !== upstreamUrl ||
      methodTag !== "POST" ||
      Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > 120 ||
      !verifyEvent(event)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("Invalid or mismatched Nostr HTTP Auth event.");
  }
}

export async function readBoundedText(response: Response, maxBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let result = "";
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Escrow response exceeded the size limit.");
    }
    result += decoder.decode(value, { stream: true });
  }

  return result + decoder.decode();
}
