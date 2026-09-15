import "server-only";

import { verifyEvent, type Event as NostrEvent } from "nostr-tools";
import type { EscrowDescriptorSource, EscrowService } from "./escrow";
import { discoverEscrowService, validateEscrowService } from "./escrow-server";

const URL_SERVICE_CACHE_MS = 30_000;
type UrlServiceCache = Map<string, { expiresAt: number; service: Promise<EscrowService> }>;
const backend = globalThis as typeof globalThis & { __rollpotValidatedUrlServices?: UrlServiceCache };
const validatedUrlServices = backend.__rollpotValidatedUrlServices ??= new Map();

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
