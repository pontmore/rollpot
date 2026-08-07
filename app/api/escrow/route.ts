import { NextResponse } from "next/server";
import { verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { REQUIRED_OPERATIONS, type EscrowDescriptorSource } from "../../../lib/escrow";
import { discoverEscrowService, validateEscrowService } from "../../../lib/escrow-server";

const ALLOWED_OPERATIONS = new Set<string>(REQUIRED_OPERATIONS);

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      service_source?: EscrowDescriptorSource;
      operation?: string;
      authorization?: string;
      payload?: unknown;
    };

    const operation = body.operation?.trim();
    const startedAt = Date.now();

    if (!operation || !ALLOWED_OPERATIONS.has(operation)) {
      return NextResponse.json({ error: "Unsupported escrow operation." }, { status: 400 });
    }

    if (!body.authorization?.startsWith("Nostr ")) {
      return NextResponse.json({ error: "Missing Nostr HTTP Auth header." }, { status: 400 });
    }

    const service = await discoverSource(body.service_source);
    const upstreamUrl = service.operation_urls[operation as keyof typeof service.operation_urls];
    validateNip98Authorization(body.authorization, upstreamUrl);

    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: body.authorization,
      },
      body: JSON.stringify(body.payload ?? {}),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await readBoundedText(upstream, 1024 * 1024);
    const elapsedMs = Date.now() - startedAt;

    if (!upstream.ok) {
      console.warn("[rollpot] escrow upstream error", {
        operation,
        status: upstream.status,
        elapsedMs,
        body: text.slice(0, 500),
      });
    }

    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (error) {
    console.error("[rollpot] escrow proxy error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Escrow request failed." }, { status: 400 });
  }
}

async function discoverSource(source: EscrowDescriptorSource | undefined) {
  if (!source) throw new Error("Missing escrow descriptor source.");
  if (source.type === "url") return discoverEscrowService(source.url);
  if (
    source.event.kind !== 30361 ||
    !source.event.tags.some(([name, value]) => name === "d" && Boolean(value)) ||
    !verifyEvent(source.event as NostrEvent)
  ) {
    throw new Error("Invalid escrow descriptor event.");
  }
  return validateEscrowService(JSON.parse(source.event.content), source);
}

function validateNip98Authorization(authorization: string, upstreamUrl: string) {
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

async function readBoundedText(response: Response, maxBytes: number) {
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
