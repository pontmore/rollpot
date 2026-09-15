import { NextResponse } from "next/server";
import { REQUIRED_OPERATIONS, type EscrowDescriptorSource } from "../../../lib/escrow";
import { discoverSource, readBoundedText, validateNip98Authorization } from "../../../lib/escrow-request";

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
    const discoveredAt = Date.now();
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
        "server-timing": `discovery;dur=${discoveredAt - startedAt}, upstream;dur=${elapsedMs - (discoveredAt - startedAt)}`,
      },
    });
  } catch (error) {
    console.error("[rollpot] escrow proxy error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Escrow request failed." }, { status: 400 });
  }
}
