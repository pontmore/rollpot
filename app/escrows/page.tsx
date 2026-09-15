import { RollpotClient } from "../../components/rollpot-client";
import { connection } from "next/server";
import { DESCRIPTOR_URL, type EscrowService } from "../../lib/escrow";
import { discoverSource } from "../../lib/escrow-request";

export default async function EscrowsPage() {
  await connection();
  let initialService: EscrowService | null = null;

  try {
    initialService = await discoverSource({ type: "url", url: DESCRIPTOR_URL });
  } catch {
    // The page still allows direct URL and relay discovery if the default is down.
  }

  return <RollpotClient page="escrows" initialService={initialService} />;
}
