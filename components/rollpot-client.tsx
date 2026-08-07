"use client";

import AddIcon from "@mui/icons-material/Add";
import CasinoIcon from "@mui/icons-material/Casino";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import HistoryIcon from "@mui/icons-material/History";
import LocalAtmIcon from "@mui/icons-material/LocalAtm";
import LoginIcon from "@mui/icons-material/Login";
import PersonIcon from "@mui/icons-material/Person";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Container,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { nip19 } from "nostr-tools";
import { DiceFace } from "./dice-face";
import { FundingStatusCard } from "./status-card";
import {
  buildApplicationReleaseDecision,
  buildNip98Authorization,
  connectNostrPlayer,
  createLocalNostrPlayer,
  loadCurrentPlayer,
  loadOrCreateIdentity,
  rollDie,
  savePlayerProfile,
} from "../lib/crypto";
import {
  type CreateEscrowResponse,
  type DiceGameResult,
  type EscrowDescriptor,
  type EscrowIdentity,
  type FundStatusResponse,
  type FundingInstructionsResponse,
  type GameInvite,
  type PlayerProfile,
  type ReleaseEscrowResponse,
  type TrackedDiceGame,
  getServiceEndpoint,
} from "../lib/escrow";

const APP_SECRET_STORAGE = "pontmore-rollpot-app-secret";
const GAMES_STORAGE = "pontmore-dice-games";

export function RollpotClient({ descriptor }: { descriptor: EscrowDescriptor }) {
  const endpoint = getServiceEndpoint(descriptor);
  const initialFundingModel = descriptor.service?.funding_model?.includes("two_party")
    ? "two_party"
    : descriptor.service?.default_funding_model || "single_funder";
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [amountSats, setAmountSats] = useState("100");
  const [counterpartyPubkey, setCounterpartyPubkey] = useState("");
  const [fundingModel] = useState(initialFundingModel);
  const [playerIdentity, setPlayerIdentity] = useState<EscrowIdentity | null>(null);
  const [playerProfile, setPlayerProfile] = useState<PlayerProfile | null>(null);
  const [appSigner, setAppSigner] = useState<EscrowIdentity | null>(null);
  const [escrow, setEscrow] = useState<CreateEscrowResponse | null>(null);
  const [localRole, setLocalRole] = useState<"creator" | "counterparty">("creator");
  const [creatorPlayer, setCreatorPlayer] = useState<PlayerProfile | null>(null);
  const [counterpartyPlayer, setCounterpartyPlayer] = useState<PlayerProfile | null>(null);
  const [creatorFunding, setCreatorFunding] = useState<FundingInstructionsResponse | null>(null);
  const [counterpartyFunding, setCounterpartyFunding] = useState<FundingInstructionsResponse | null>(null);
  const [creatorStatus, setCreatorStatus] = useState<FundStatusResponse | null>(null);
  const [counterpartyStatus, setCounterpartyStatus] = useState<FundStatusResponse | null>(null);
  const [gameResult, setGameResult] = useState<DiceGameResult | null>(null);
  const [releaseResponse, setReleaseResponse] = useState<ReleaseEscrowResponse | null>(null);
  const [trackedGames, setTrackedGames] = useState<TrackedDiceGame[]>([]);
  const [activeGameId, setActiveGameId] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void loadCurrentPlayer()
      .then((player) => {
        if (!player) return;
        setPlayerIdentity(player.identity);
        setPlayerProfile(player.profile);
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    setAppSigner(loadOrCreateIdentity("Rollpot application", APP_SECRET_STORAGE));
    const savedGames = loadTrackedGames();
    setTrackedGames(savedGames);

    if (savedGames[0]) {
      restoreTrackedGame(savedGames[0]);
    }
  }, []);

  useEffect(() => {
    if (playerProfile) {
      savePlayerProfile(playerProfile);
    }
  }, [playerProfile]);

  const canCallService = Boolean(endpoint && playerIdentity && playerProfile?.lightning_address && appSigner);
  const profileConfigured = Boolean(playerIdentity && playerProfile?.name.trim() && playerProfile.lightning_address.trim());
  const needsName = Boolean(playerIdentity && !playerProfile?.name.trim());
  const needsLightningAddress = Boolean(playerIdentity && !playerProfile?.lightning_address.trim());
  const normalizedCounterpartyPubkey = normalizeNostrPubkey(counterpartyPubkey);
  const counterpartyPubkeyError = counterpartyPubkey.trim() && !normalizedCounterpartyPubkey
    ? "Enter a valid npub or 64-character hex public key."
    : normalizedCounterpartyPubkey === playerIdentity?.pubkey
      ? "Player 2 must use a different Nostr identity."
      : "";
  const playerJoined = Boolean(
    escrow?.counterparty_pubkey || counterpartyPlayer || (creatorStatus?.total_funders ?? 0) >= 2,
  );
  const creatorPaid = Boolean(creatorStatus?.funded || creatorStatus?.my_funded);
  const counterpartyPaid = Boolean(counterpartyStatus?.funded || counterpartyStatus?.my_funded);
  const requiresCounterpartyBeforeFunding = fundingModel === "two_party" || fundingModel === "m_of_n";
  const canRequestPayment = Boolean(escrow && (!requiresCounterpartyBeforeFunding || playerJoined));
  const paymentsReady = fundingModel === "two_party" ? creatorPaid && counterpartyPaid : creatorPaid;
  const myFunding = localRole === "creator" ? creatorFunding : counterpartyFunding;
  const myStatus = localRole === "creator" ? creatorStatus : counterpartyStatus;
  const inviteCode = useMemo(() => {
    if (!escrow || localRole !== "creator" || !creatorPlayer || releaseResponse) {
      return "";
    }

    const enrollment = escrow.enrollments?.[0];

    if (!enrollment) {
      return "";
    }

    return encodeInvite({
      version: 1,
      game: "rollpot",
      escrow_id: escrow.escrow_id,
      enrollment_token: enrollment.enrollment_token,
      counterparty_pubkey: enrollment.participant_pubkey,
      amount_sats: escrow.amount_sats,
      funding_model: escrow.funding_model,
      creator_player: creatorPlayer,
      created_at: new Date().toISOString(),
    });
  }, [creatorPlayer, escrow, localRole, releaseResponse]);

  useEffect(() => {
    if (!escrow || !playerIdentity || localRole !== "creator" || playerJoined || releaseResponse) {
      return;
    }

    let cancelled = false;
    const syncParticipants = async () => {
      try {
        const status = await callEscrow<FundStatusResponse>(playerIdentity, "fund_status", {
          escrow_id: escrow.escrow_id,
        });

        if (!cancelled) {
          setCreatorStatus(status);
        }
      } catch {
        // Manual status checks still surface service errors to the player.
      }
    };

    void syncParticipants();
    const interval = window.setInterval(syncParticipants, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [escrow, localRole, playerIdentity, playerJoined, releaseResponse]);

  async function createEscrow() {
    if (!playerIdentity || !playerProfile) return;
    assertPlayableProfile(playerProfile);
    const participantPubkey = normalizeNostrPubkey(counterpartyPubkey);

    if (!participantPubkey) {
      setError("Enter Player 2's npub or 64-character hex Nostr public key.");
      return;
    }

    if (participantPubkey === playerIdentity.pubkey) {
      setError("Player 2 must use a different Nostr identity.");
      return;
    }

    await runOperation(async () => {
      const created = await callEscrow<CreateEscrowResponse>(playerIdentity, "create", {
        amount_sats: Number(amountSats),
        description: "Rollpot wager",
        refund_ln_address: playerProfile.lightning_address,
        participant_pubkeys: [participantPubkey],
        funding_model: fundingModel,
        idempotency_key: crypto.randomUUID(),
      });
      const game = baseTrackedGame({
        escrow: created,
        role: "creator",
        creator: playerProfile,
        counterparty: null,
      });

      applyTrackedGame(game);
      saveTrackedGame(game);
    });
  }

  async function loginWithNostr() {
    setAuthBusy(true);
    setError("");

    try {
      const player = await connectNostrPlayer();
      setPlayerIdentity(player.identity);
      setPlayerProfile(player.profile);
      savePlayerProfile(player.profile);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setAuthBusy(false);
    }
  }

  function signupLocalPlayer() {
    setError("");

    try {
      const player = createLocalNostrPlayer();
      setPlayerIdentity(player.identity);
      setPlayerProfile(player.profile);
      savePlayerProfile(player.profile);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function joinInvite() {
    if (!playerIdentity || !playerProfile) return;
    assertPlayableProfile(playerProfile);

    const invite = decodeInvite(inviteInput);

    if (invite.counterparty_pubkey !== playerIdentity.pubkey) {
      setError("This invite is bound to a different Nostr identity.");
      return;
    }

    await runOperation(async () => {
      const joined = await callEscrow<CreateEscrowResponse>(playerIdentity, "create", {
        enrollment_token: invite.enrollment_token,
      });
      const game = baseTrackedGame({
        escrow: joined,
        role: "counterparty",
        creator: invite.creator_player,
        counterparty: playerProfile,
      });

      applyTrackedGame(game);
      saveTrackedGame(game);
      setInviteInput("");
    });
  }

  async function loadMyFunding() {
    if (!escrow || !playerIdentity) return;

    await runOperation(async () => {
      const instructions = await callEscrow<FundingInstructionsResponse>(playerIdentity, "funding_instructions", {
        escrow_id: escrow.escrow_id,
      });

      if (localRole === "creator") {
        setCreatorFunding(instructions);
        saveCurrentGame({ creator_funding: instructions });
      } else {
        setCounterpartyFunding(instructions);
        saveCurrentGame({ counterparty_funding: instructions });
      }
    });
  }

  async function refreshMyStatus() {
    if (!escrow || !playerIdentity) return;

    await runOperation(async () => {
      const status = await callEscrow<FundStatusResponse>(playerIdentity, "fund_status", {
        escrow_id: escrow.escrow_id,
      });

      if (localRole === "creator") {
        setCreatorStatus(status);
        saveCurrentGame({ creator_status: status });
      } else {
        setCounterpartyStatus(status);
        saveCurrentGame({ counterparty_status: status });
      }
    });
  }

  async function rollAndRelease() {
    if (!escrow || !appSigner || !playerIdentity) return;

    await runOperation(async () => {
      const creatorRoll = rollDie();
      const counterpartyRoll = rollDie(creatorRoll);
      const winner = creatorRoll > counterpartyRoll ? "creator" : "counterparty";
      const winnerProfile = winner === "creator" ? creatorPlayer : counterpartyPlayer;
      const result: DiceGameResult = {
        escrow_id: escrow.escrow_id,
        creator_roll: creatorRoll,
        counterparty_roll: counterpartyRoll,
        winner,
        rolled_at: new Date().toISOString(),
        winner_name: winnerProfile?.name || (winner === "creator" ? "Player 1" : "Player 2"),
        settlement_address: winnerProfile?.lightning_address || "",
      };
      const decision = buildApplicationReleaseDecision({
        appSigner,
        escrowId: escrow.escrow_id,
        result,
        nonce: crypto.randomUUID(),
        timestamp: Math.floor(Date.now() / 1000),
      });
      const release = await callEscrow<ReleaseEscrowResponse>(playerIdentity, "release", {
        escrow_id: escrow.escrow_id,
        decision,
      });

      setGameResult(result);
      setReleaseResponse(release);
      saveCurrentGame({ result, release });
    });
  }

  function updatePlayerProfile(update: Partial<PlayerProfile>) {
    setPlayerProfile((current) => {
      if (!current) return current;
      const next = { ...current, ...update };

      if (escrow) {
        if (localRole === "creator") {
          setCreatorPlayer(next);
          saveCurrentGame({ creator_player: next });
        } else {
          setCounterpartyPlayer(next);
          saveCurrentGame({ counterparty_player: next });
        }
      }

      return next;
    });
  }

  function startNewGame() {
    setActiveGameId("");
    setCounterpartyPubkey("");
    setEscrow(null);
    setLocalRole("creator");
    setCreatorPlayer(playerProfile);
    setCounterpartyPlayer(null);
    setCreatorFunding(null);
    setCounterpartyFunding(null);
    setCreatorStatus(null);
    setCounterpartyStatus(null);
    setGameResult(null);
    setReleaseResponse(null);
    setError("");
  }

  function restoreTrackedGame(game: TrackedDiceGame) {
    applyTrackedGame(game);
    setError("");
  }

  function applyTrackedGame(game: TrackedDiceGame) {
    setActiveGameId(game.id);
    setAmountSats(String(game.amount_sats));
    setCounterpartyPubkey("");
    setEscrow(game.escrow);
    setLocalRole(game.local_role);
    setCreatorPlayer(game.creator_player);
    setCounterpartyPlayer(game.counterparty_player);
    setCreatorFunding(game.creator_funding);
    setCounterpartyFunding(game.counterparty_funding);
    setCreatorStatus(game.creator_status);
    setCounterpartyStatus(game.counterparty_status);
    setGameResult(game.result);
    setReleaseResponse(game.release);
  }

  function saveCurrentGame(overrides: Partial<TrackedDiceGame>) {
    if (!escrow || !creatorPlayer) return;

    const now = new Date().toISOString();
    const current = trackedGames.find((game) => game.id === escrow.escrow_id);
    const nextGame: TrackedDiceGame = {
      id: escrow.escrow_id,
      created_at: current?.created_at || now,
      updated_at: now,
      amount_sats: escrow.amount_sats,
      funding_model: escrow.funding_model,
      refund_ln_address: playerProfile?.lightning_address || current?.refund_ln_address || "",
      local_role: localRole,
      creator_player: creatorPlayer,
      counterparty_player: counterpartyPlayer,
      escrow,
      creator_funding: creatorFunding,
      counterparty_funding: counterpartyFunding,
      creator_status: creatorStatus,
      counterparty_status: counterpartyStatus,
      result: gameResult,
      release: releaseResponse,
      ...overrides,
    };

    saveTrackedGame(nextGame);
  }

  function saveTrackedGame(game: TrackedDiceGame) {
    setActiveGameId(game.id);
    setTrackedGames((current) => {
      const nextGames = [game, ...current.filter((entry) => entry.id !== game.id)]
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
        .slice(0, 20);

      window.localStorage.setItem(GAMES_STORAGE, JSON.stringify(nextGames));
      return nextGames;
    });
  }

  async function runOperation(operation: () => Promise<void>) {
    setBusy(true);
    setError("");

    try {
      await operation();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function callEscrow<T>(
    identity: EscrowIdentity,
    operation: string,
    payload: unknown,
  ): Promise<T> {
    const upstreamUrl = `${endpoint}/${operation}`;
    const response = await fetch("/api/escrow", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint,
        operation,
        authorization: await buildNip98Authorization(identity, "POST", upstreamUrl),
        payload,
      }),
    });
    const body = await response.json();

    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error(
          `Escrow service error while processing ${operation} (HTTP ${response.status}). ` +
            "The enrollment token may have been consumed by the service; do not retry the same invite until the escrow service is checked.",
        );
      }

      if (
        operation === "funding_instructions" &&
        body?.error === "authenticated pubkey is not a registered funder for this escrow"
      ) {
        throw new Error(
          "The escrow service did not register this participant as a funder. This escrow is incomplete and cannot be funded; create a new game after the service enrollment issue is fixed.",
        );
      }

      throw new Error(body?.error || JSON.stringify(body));
    }

    return body as T;
  }

  return (
    <Box component="main" sx={{ minHeight: "100vh", py: { xs: 2, md: 4 } }}>
      <Container maxWidth="lg">
        <Stack spacing={2.5}>
          <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: { xs: 2, md: 3 } }}>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2.5} sx={{ alignItems: { md: "center" }, justifyContent: "space-between" }}>
              <Box>
                <Chip icon={<CasinoIcon />} label="Rollpot" color="primary" sx={{ mb: 1.5 }} />
                <Typography component="h1" variant="h2" sx={{ fontWeight: 900, letterSpacing: 0 }}>
                  Rollpot
                </Typography>
                <Typography color="text.secondary">Invite a Nostr player, fund the pot, roll once.</Typography>
              </Box>
              <Stack direction="row" spacing={2} sx={{ justifyContent: { xs: "center", md: "flex-end" } }}>
                <DiceFace label={creatorPlayer?.name || "Player 1"} value={gameResult?.creator_roll ?? null} />
                <DiceFace label={counterpartyPlayer?.name || "Player 2"} value={gameResult?.counterparty_roll ?? null} />
              </Stack>
            </Stack>
          </Paper>

          {busy ? <LinearProgress /> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}

          <Stack direction={{ xs: "column", md: "row" }} spacing={2.5} sx={{ alignItems: "flex-start" }}>
            <Stack spacing={2.5} sx={{ width: { xs: "100%", md: 340 }, flexShrink: 0 }}>
              <Card variant="outlined">
                <CardContent>
                  <Stack spacing={2}>
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>
                        Player
                      </Typography>
                      {playerIdentity ? <Chip size="small" label={playerIdentity.secretKey ? "local key" : "nostr signer"} color="primary" /> : null}
                    </Stack>
                    {!playerIdentity ? (
                      <Stack spacing={1.5}>
                        <Alert severity="info">Start with a Nostr identity.</Alert>
                        <AuthAction disabled={authBusy} onClick={loginWithNostr} icon={<LoginIcon />}>
                          Log in with Nostr
                        </AuthAction>
                        <AuthAction onClick={signupLocalPlayer} icon={<PersonAddIcon />} variant="outline">
                          Create local identity
                        </AuthAction>
                      </Stack>
                    ) : (
                      <Stack direction="row" spacing={1}>
                        <Button type="button" disabled={authBusy} variant="outlined" onClick={loginWithNostr} startIcon={<LoginIcon />}>
                          Switch Nostr
                        </Button>
                        <Button type="button" variant="outlined" onClick={signupLocalPlayer} startIcon={<PersonAddIcon />}>
                          New local
                        </Button>
                      </Stack>
                    )}
                    {playerIdentity ? (
                      <>
                        {needsLightningAddress ? <Alert severity="warning">Add a Lightning address before creating or joining a game.</Alert> : null}
                        <TextField
                          label="Name"
                          value={playerProfile?.name || ""}
                          onChange={(event) => updatePlayerProfile({ name: event.target.value })}
                          size="small"
                          required
                          error={needsName}
                          helperText={needsName ? "Required" : " "}
                        />
                        <TextField label="Nostr npub" value={playerProfile?.npub || ""} size="small" slotProps={{ input: { readOnly: true } }} />
                        <TextField
                          label="Lightning address"
                          value={playerProfile?.lightning_address || ""}
                          onChange={(event) => updatePlayerProfile({ lightning_address: event.target.value })}
                          size="small"
                          required
                          error={needsLightningAddress}
                          helperText={needsLightningAddress ? "Required for refunds and payouts" : " "}
                        />
                      </>
                    ) : null}
                  </Stack>
                </CardContent>
              </Card>

              {profileConfigured ? (
                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={2}>
                      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                        <Typography variant="h6" sx={{ fontWeight: 900 }}>
                          Play
                        </Typography>
                        <Button size="small" variant="text" startIcon={<AddIcon />} onClick={startNewGame}>
                          New
                        </Button>
                      </Stack>
                      <TextField label="Amount per player, sats" value={amountSats} onChange={(event) => setAmountSats(event.target.value)} size="small" type="number" />
                      <TextField
                        label="Player 2 Nostr pubkey"
                        value={counterpartyPubkey}
                        onChange={(event) => setCounterpartyPubkey(event.target.value)}
                        size="small"
                        placeholder="npub1... or 64-character hex"
                        error={Boolean(counterpartyPubkeyError)}
                        helperText={counterpartyPubkeyError || "The invite will be bound to this identity."}
                      />
                      <Button
                        disabled={!canCallService || !normalizedCounterpartyPubkey || Boolean(counterpartyPubkeyError) || busy}
                        variant="contained"
                        onClick={createEscrow}
                        startIcon={<LocalAtmIcon />}
                      >
                        Create game
                      </Button>
                      <TextField label="Invite code" value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} size="small" multiline minRows={3} />
                      <Button disabled={!canCallService || !inviteInput.trim() || busy} variant="outlined" onClick={joinInvite} startIcon={<LoginIcon />}>
                        Join game
                      </Button>
                      {trackedGames.length > 0 ? (
                        <Stack spacing={1} sx={{ pt: 1 }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                            <HistoryIcon color="primary" fontSize="small" />
                            <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>
                              Saved games
                            </Typography>
                          </Stack>
                          {trackedGames.slice(0, 4).map((game) => (
                            <Button
                              key={game.id}
                              variant={game.id === activeGameId ? "contained" : "outlined"}
                              color={game.release ? "success" : "primary"}
                              onClick={() => restoreTrackedGame(game)}
                              sx={{ justifyContent: "flex-start", textAlign: "left" }}
                            >
                              <Stack spacing={0.25} sx={{ alignItems: "flex-start", width: "100%" }}>
                                <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>
                                  {game.release ? winnerLabel(game.release.recipient, game) : `${game.amount_sats} sats per player`}
                                </Typography>
                                <Typography variant="caption" sx={{ opacity: 0.8 }}>
                                  {game.release ? "Settled" : gameStatusLabel(game)} · {formatGameTime(game.updated_at)}
                                </Typography>
                              </Stack>
                            </Button>
                          ))}
                        </Stack>
                      ) : null}
                    </Stack>
                  </CardContent>
                </Card>
              ) : null}
            </Stack>

            <Stack spacing={2.5} sx={{ flex: 1, minWidth: 0, width: "100%" }}>
              {!profileConfigured ? (
                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={2}>
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>
                        Complete profile
                      </Typography>
                      <Typography color="text.secondary">Rollpot needs a player name, Nostr pubkey, and Lightning address before games are available.</Typography>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                        <Chip label={playerIdentity ? "Nostr ready" : "Nostr required"} color={playerIdentity ? "success" : "default"} />
                        <Chip label={needsName ? "Name required" : "Name ready"} color={needsName ? "warning" : "success"} />
                        <Chip label={needsLightningAddress ? "Lightning required" : "Lightning ready"} color={needsLightningAddress ? "warning" : "success"} />
                      </Stack>
                    </Stack>
                  </CardContent>
                </Card>
              ) : (
                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={2}>
                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
                        <Box>
                          <Typography variant="h6" sx={{ fontWeight: 900 }}>
                            Current game
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {escrow ? `${escrow.amount_sats * (fundingModel === "two_party" ? 2 : 1)} sats pot` : "No active game"}
                          </Typography>
                        </Box>
                        {escrow ? <Chip label={releaseResponse ? "settled" : paymentsReady ? "ready to roll" : "funding"} color={releaseResponse || paymentsReady ? "success" : "default"} /> : null}
                      </Stack>

                      {escrow ? (
                        <Stack spacing={2.25}>
                        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                          <PlayerLine label="Player 1" profile={creatorPlayer} ready={Boolean(creatorPlayer)} paid={creatorPaid} />
                          <PlayerLine label="Player 2" profile={counterpartyPlayer} ready={playerJoined} paid={counterpartyPaid} />
                        </Stack>

                          {inviteCode ? <InviteCode code={inviteCode} /> : null}

                          <FundingStatusCard
                            title="Your payment"
                            disabled={!canRequestPayment || busy}
                            instructions={myFunding}
                            status={myStatus}
                            waitingForPlayers={Boolean(escrow && requiresCounterpartyBeforeFunding && !playerJoined)}
                            onInstructions={loadMyFunding}
                            onStatus={refreshMyStatus}
                          />

                          <Button disabled={!escrow || !paymentsReady || busy || Boolean(releaseResponse)} variant="contained" color="secondary" onClick={rollAndRelease} startIcon={<CasinoIcon />}>
                            Roll
                          </Button>
                          {releaseResponse ? (
                            <Alert severity="success">
                              {winnerLabel(releaseResponse.recipient, {
                                creator_player: creatorPlayer || fallbackPlayer("Player 1"),
                                counterparty_player: counterpartyPlayer,
                              })} {releaseResponse.payout_sats} sats.
                            </Alert>
                          ) : null}
                        </Stack>
                      ) : (
                        <Alert severity="info">Create a game or paste an invite code to start.</Alert>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              )}
            </Stack>
          </Stack>
        </Stack>
      </Container>
    </Box>
  );
}

function baseTrackedGame({
  escrow,
  role,
  creator,
  counterparty,
}: {
  escrow: CreateEscrowResponse;
  role: "creator" | "counterparty";
  creator: PlayerProfile;
  counterparty: PlayerProfile | null;
}): TrackedDiceGame {
  const now = new Date().toISOString();

  return {
    id: escrow.escrow_id,
    created_at: now,
    updated_at: now,
    amount_sats: escrow.amount_sats,
    funding_model: escrow.funding_model,
    refund_ln_address: role === "creator" ? creator.lightning_address : counterparty?.lightning_address || "",
    local_role: role,
    creator_player: creator,
    counterparty_player: counterparty,
    escrow,
    creator_funding: null,
    counterparty_funding: null,
    creator_status: null,
    counterparty_status: null,
    result: null,
    release: null,
  };
}

function InviteCode({ code }: { code: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, textTransform: "uppercase" }}>
        Invite code
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <Typography variant="body2" sx={{ overflowWrap: "anywhere", minWidth: 0 }}>
          {code}
        </Typography>
        <Tooltip title="Copy invite">
          <Button size="small" variant="text" onClick={() => navigator.clipboard.writeText(code)} sx={{ minWidth: 36 }}>
            <ContentCopyIcon fontSize="small" />
          </Button>
        </Tooltip>
      </Stack>
    </Box>
  );
}

function AuthAction({
  children,
  disabled = false,
  icon,
  onClick,
  variant = "solid",
}: {
  children: ReactNode;
  disabled?: boolean;
  icon: ReactNode;
  onClick: () => void;
  variant?: "solid" | "outline";
}) {
  return (
    <Box
      component="button"
      type="button"
      disabled={disabled}
      onClick={onClick}
      sx={{
        alignItems: "center",
        bgcolor: variant === "solid" ? "primary.main" : "transparent",
        border: "1px solid",
        borderColor: variant === "solid" ? "primary.main" : "primary.dark",
        borderRadius: 1,
        color: variant === "solid" ? "primary.contrastText" : "primary.main",
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        font: "inherit",
        fontWeight: 900,
        gap: 1.25,
        justifyContent: "center",
        minHeight: 54,
        opacity: disabled ? 0.5 : 1,
        px: 2,
        py: 1.25,
        textTransform: "uppercase",
        touchAction: "manipulation",
        width: "100%",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {icon}
      <span>{children}</span>
    </Box>
  );
}

function loadTrackedGames(): TrackedDiceGame[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GAMES_STORAGE) || "[]") as TrackedDiceGame[];

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((game) => game?.id && game?.escrow?.escrow_id && game?.creator_player)
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  } catch {
    return [];
  }
}

function encodeInvite(invite: GameInvite) {
  return btoa(JSON.stringify(invite)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeInvite(value: string): GameInvite {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const invite = JSON.parse(atob(padded)) as GameInvite;

  if (
    invite.version !== 1 ||
    invite.game !== "rollpot" ||
    !invite.enrollment_token ||
    !/^[0-9a-f]{64}$/.test(invite.counterparty_pubkey) ||
    !invite.creator_player?.lightning_address
  ) {
    throw new Error("Invite code is not a valid Rollpot invite.");
  }

  return invite;
}

function normalizeNostrPubkey(value: string): string | null {
  const trimmed = value.trim().toLowerCase();

  if (/^[0-9a-f]{64}$/.test(trimmed)) {
    return trimmed;
  }

  if (!trimmed.startsWith("npub1")) {
    return null;
  }

  try {
    const decoded = nip19.decode(trimmed);
    return decoded.type === "npub" && typeof decoded.data === "string" ? decoded.data : null;
  } catch {
    return null;
  }
}

function assertPlayableProfile(profile: PlayerProfile) {
  if (!profile.name.trim()) {
    throw new Error("Enter your player name.");
  }

  if (!profile.lightning_address.trim()) {
    throw new Error("Enter your Lightning address before creating or joining a game.");
  }
}

function gameStatusLabel(game: TrackedDiceGame) {
  const creatorPaid = Boolean(game.creator_status?.funded || game.creator_status?.my_funded);
  const counterpartyPaid = Boolean(game.counterparty_status?.funded || game.counterparty_status?.my_funded);

  if (creatorPaid && counterpartyPaid) return "Ready to roll";
  if (game.counterparty_player || game.escrow.counterparty_pubkey) return "Funding";
  return "Waiting for player 2";
}

function winnerLabel(
  recipient: "creator" | "counterparty",
  game: Pick<TrackedDiceGame, "creator_player" | "counterparty_player">,
) {
  return recipient === "creator" ? game.creator_player?.name || "Player 1 won" : game.counterparty_player?.name || "Player 2 won";
}

function fallbackPlayer(name: string): PlayerProfile {
  return {
    name,
    npub: "",
    pubkey: "",
    lightning_address: "",
  };
}

function formatGameTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "saved";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function PlayerLine({
  label,
  profile,
  ready,
  paid,
}: {
  label: string;
  profile: PlayerProfile | null;
  ready: boolean;
  paid: boolean;
}) {
  return (
    <Stack spacing={0.75}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <PersonIcon fontSize="small" color={ready ? "primary" : "disabled"} />
          <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>
            {profile?.name || label}
          </Typography>
        </Stack>
        <Chip size="small" label={paid ? "paid" : ready ? "ready" : "not joined"} color={paid ? "success" : "default"} />
      </Stack>
      {profile ? (
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          {profile.npub} · {profile.lightning_address}
        </Typography>
      ) : null}
    </Stack>
  );
}
