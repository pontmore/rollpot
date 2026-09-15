import { NextResponse } from "next/server";
import { discoverSource } from "../../../lib/escrow-request";
import type { EscrowDescriptorSource } from "../../../lib/escrow";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { descriptor_url?: string; source?: EscrowDescriptorSource };
    const service = await discoverSource(body.source ?? { type: "url", url: body.descriptor_url?.trim() || "" });
    return NextResponse.json(service);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Descriptor discovery failed." },
      { status: 400 },
    );
  }
}
