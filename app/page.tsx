import { RollpotClient } from "../components/rollpot-client";
import { DESCRIPTOR_URL } from "../lib/escrow";
import { discoverEscrowService } from "../lib/escrow-server";
import type { EscrowService } from "../lib/escrow";

export default async function Home() {
  let initialService: EscrowService | null = null;

  try {
    initialService = await discoverEscrowService(DESCRIPTOR_URL);
  } catch {
    // Page renders without a preselected escrow when the default is unavailable.
  }

  return <RollpotClient initialService={initialService} />;
}
