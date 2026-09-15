import { RollpotClient } from "../components/rollpot-client";
import { connection } from "next/server";
import { DESCRIPTOR_URL } from "../lib/escrow";
import { discoverSource } from "../lib/escrow-request";
import type { EscrowService } from "../lib/escrow";

export default async function Home() {
  await connection();
  let initialService: EscrowService | null = null;

  try {
    initialService = await discoverSource({ type: "url", url: DESCRIPTOR_URL });
  } catch {
    // Page renders without a preselected escrow when the default is unavailable.
  }

  return <RollpotClient page="home" initialService={initialService} />;
}
