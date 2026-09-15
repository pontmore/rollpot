import { NextResponse } from "next/server";
import type { EscrowDescriptorSource, FundStatusResponse } from "../../../../lib/escrow";
import { discoverSource, readBoundedText, validateNip98Authorization } from "../../../../lib/escrow-request";

const POLL_INTERVAL_MS = 5_000;
const STREAM_LIFETIME_MS = 60_000;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      service_source?: EscrowDescriptorSource;
      escrow_id?: string;
      authorization?: string;
    };
    if (!body.escrow_id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.escrow_id)) {
      return NextResponse.json({ error: "Invalid escrow ID." }, { status: 400 });
    }
    if (!body.authorization?.startsWith("Nostr ")) {
      return NextResponse.json({ error: "Missing Nostr HTTP Auth header." }, { status: 400 });
    }

    // Discover once per connection. Each backend poll uses the same validated
    // operation URL and short-lived NIP-98 authorization.
    const service = await discoverSource(body.service_source);
    const upstreamUrl = service.operation_urls.fund_status;
    validateNip98Authorization(body.authorization, upstreamUrl);

    const encoder = new TextEncoder();
    let cancelled = false;
    let pollAbort: AbortController | null = null;
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveDelay: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          if (!cancelled) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const close = () => {
          if (cancelled) return;
          cancelled = true;
          controller.close();
        };
        const waitForNextPoll = () => new Promise<void>((resolve) => {
          resolveDelay = resolve;
          delayTimer = setTimeout(() => {
            delayTimer = null;
            resolveDelay = null;
            resolve();
          }, POLL_INTERVAL_MS);
        });

        void (async () => {
          const expiresAt = Date.now() + STREAM_LIFETIME_MS;
          while (!cancelled && Date.now() < expiresAt) {
            try {
              pollAbort = new AbortController();
              const upstream = await fetch(upstreamUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: body.authorization!,
                },
                body: JSON.stringify({ escrow_id: body.escrow_id }),
                cache: "no-store",
                redirect: "manual",
                signal: AbortSignal.any([pollAbort.signal, AbortSignal.timeout(20_000)]),
              });
              const text = await readBoundedText(upstream, 64 * 1024);
              if (!upstream.ok) {
                send("error", { status: upstream.status });
                break;
              }
              const status = JSON.parse(text) as FundStatusResponse;
              if (status.escrow_id !== body.escrow_id) {
                throw new Error("Escrow status did not match the requested game.");
              }
              send("status", status);
              await waitForNextPoll();
            } catch {
              if (!cancelled) send("error", { status: 502 });
              break;
            } finally {
              pollAbort = null;
            }
          }
          close();
        })();
      },
      cancel() {
        cancelled = true;
        pollAbort?.abort();
        if (delayTimer) clearTimeout(delayTimer);
        resolveDelay?.();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Escrow event stream failed." }, { status: 400 });
  }
}
