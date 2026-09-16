import { RollpotClient } from "../../components/rollpot-client";
import { connection } from "next/server";
import type { EscrowService } from "../../lib/escrow";
import { discoverConfiguredEscrow } from "../../lib/escrow-request";

export default async function EscrowsPage() {
  await connection();
  let initialService: EscrowService | null = null;

  try {
    initialService = await discoverConfiguredEscrow();
  } catch {
    // The page still allows relay discovery if the configured default is unavailable.
  }

  return <RollpotClient page="escrows" initialService={initialService} />;
}
