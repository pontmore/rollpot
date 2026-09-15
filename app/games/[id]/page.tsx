import { RollpotClient } from "../../../components/rollpot-client";

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RollpotClient page="game" gameId={id} />;
}
