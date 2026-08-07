import { NextResponse } from "next/server";
import { verifyEvent } from "nostr-tools";
import { discoverEscrowService, validateEscrowService } from "../../../lib/escrow-server";
import type { EscrowDescriptorSource, NostrEvent } from "../../../lib/escrow";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { descriptor_url?: string; source?: EscrowDescriptorSource };
    const service = body.source
      ? await discoverFromSource(body.source)
      : await discoverEscrowService(body.descriptor_url?.trim() || "");
    return NextResponse.json(service);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Descriptor discovery failed." },
      { status: 400 },
    );
  }
}

async function discoverFromSource(source: EscrowDescriptorSource) {
  if (source.type === "url") return discoverEscrowService(source.url);
  assertDescriptorEvent(source.event);
  return validateEscrowService(JSON.parse(source.event.content), source);
}

function assertDescriptorEvent(event: NostrEvent) {
  if (event.kind !== 30361 || !event.tags.some(([name, value]) => name === "d" && Boolean(value)) || !verifyEvent(event)) {
    throw new Error("Invalid PIP-01 escrow descriptor event.");
  }
}
