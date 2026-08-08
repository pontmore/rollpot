"use client";

import AddIcon from "@mui/icons-material/Add";
import CasinoIcon from "@mui/icons-material/Casino";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import HistoryIcon from "@mui/icons-material/History";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
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
  Dialog,
  DialogContent,
  DialogTitle,
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
  type EscrowCatalogEntry,
  type EscrowIdentity,
  type EscrowService,
  type FundStatusResponse,
  type FundingInstructionsResponse,
  type GameInvite,
  type PlayerProfile,
  type ReleaseEscrowResponse,
  type TrackedDiceGame,
} from "../lib/escrow";

const APP_SECRET_STORAGE = "pontmore-rollpot-app-secret";
const GAMES_STORAGE = "pontmore-dice-games";

export function RollpotClient({ initialService }: { initialService?: EscrowService | null }) {
  const [busy, setBusy] = useState(false);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [amountSats, setAmountSats] = useState("100");
  const [counterpartyPubkey, setCounterpartyPubkey] = useState("");
  const [service, setService] = useState<EscrowService | null>(initialService ?? null);
  const [serviceSelected, setServiceSelected] = useState(Boolean(initialService));
  const [descriptorInput, setDescriptorInput] = useState(initialService?.source.type === "url" ? initialService.source.url : "");
  const [catalog, setCatalog] = useState<EscrowCatalogEntry[]>(
    initialService
      ? [
          {
            service: initialService,
            descriptor: initialService.descriptor,
            source: initialService.source,
            publisher_pubkey: "",
            identifier: "Default HTTPS escrow",
            compatible: true,
            compatibility_status: "standalone_compatible",
          },
        ]
      : [],
  );
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogExpanded, setCatalogExpanded] = useState(false);
  const [detailEntry, setDetailEntry] = useState<EscrowCatalogEntry | null>(null);
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
      void restoreTrackedGame(savedGames[0]);
    }
  }, []);

  useEffect(() => {
    if (playerProfile) {
      savePlayerProfile(playerProfile);
    }
  }, [playerProfile]);

  const fundingModel = escrow?.funding_model || "two_party";
  const trustedApplicationPubkeys = service?.descriptor.service?.decision_signers?.application_pubkeys;
  const appSignerTrusted = !trustedApplicationPubkeys?.length || Boolean(appSigner && trustedApplicationPubkeys.includes(appSigner.pubkey));
  const canAuthenticate = Boolean(playerIdentity && playerProfile?.lightning_address && appSigner);
  const canCallService = Boolean(serviceSelected && service?.endpoint && canAuthenticate && appSignerTrusted && !escrow);
  const profileConfigured = Boolean(playerIdentity && playerProfile?.name.trim() && playerProfile.lightning_address.trim());
  const needsName = Boolean(playerIdentity && !playerProfile?.name.trim());
  const needsLightningAddress = Boolean(playerIdentity && !playerProfile?.lightning_address.trim());
  const requiresCounterpartyPubkey = service?.enrollment === "predeclared_pubkey";
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
    if (!escrow || localRole !== "creator" || !creatorPlayer || !service || releaseResponse) {
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
      service_source: service.source,
    });
  }, [creatorPlayer, escrow, localRole, releaseResponse, service?.source]);

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

    startNewGame();

    const participantPubkey = normalizeNostrPubkey(counterpartyPubkey);

    if (requiresCounterpartyPubkey && !participantPubkey) {
      setError("Enter Player 2's npub or 64-character hex Nostr public key.");
      return;
    }

    if (requiresCounterpartyPubkey && participantPubkey === playerIdentity.pubkey) {
      setError("Player 2 must use a different Nostr identity.");
      return;
    }

    await runOperation(async () => {
      const created = await callEscrow<CreateEscrowResponse>(playerIdentity, "create", {
        amount_sats: Number(amountSats),
        description: "Rollpot wager",
        refund_ln_address: playerProfile.lightning_address,
        ...(requiresCounterpartyPubkey ? { participant_pubkeys: [participantPubkey] } : {}),
        funding_model: "two_party",
        idempotency_key: crypto.randomUUID(),
      });
      const game = baseTrackedGame({
        escrow: created,
        service: service!,
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

    if (invite.counterparty_pubkey && invite.counterparty_pubkey !== playerIdentity.pubkey) {
      setError("This invite is bound to a different Nostr identity.");
      return;
    }

    await runOperation(async () => {
      const inviteService = await discoverService(invite.service_source);
      const joined = await callEscrow<CreateEscrowResponse>(playerIdentity, "create", {
        enrollment_token: invite.enrollment_token,
      }, inviteService);
      const game = baseTrackedGame({
        escrow: joined,
        service: inviteService,
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

  async function restoreTrackedGame(game: TrackedDiceGame) {
    setBusy(true);
    setError("");

    try {
      const refreshedService = await discoverService(game.service.source);
      applyTrackedGame({ ...game, service: refreshedService });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  }

  function applyTrackedGame(game: TrackedDiceGame) {
    setService(game.service);
    setServiceSelected(true);
    setDescriptorInput(game.service.source.type === "url" ? game.service.source.url : "");
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
    if (!escrow || !creatorPlayer || !service) return;

    const now = new Date().toISOString();
    const gameId = getGameId(service.service_id, escrow.escrow_id);
    const current = trackedGames.find((game) => game.id === gameId);
    const nextGame: TrackedDiceGame = {
      id: gameId,
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
      service,
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

  function deleteTrackedGame(gameId: string) {
    setTrackedGames((current) => {
      const nextGames = current.filter((entry) => entry.id !== gameId);
      window.localStorage.setItem(GAMES_STORAGE, JSON.stringify(nextGames));
      return nextGames;
    });
    if (activeGameId === gameId) {
      startNewGame();
    }
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
    targetService: EscrowService | null = service,
  ): Promise<T> {
    if (!targetService) throw new Error("No escrow service selected.");
    const validatedService = await discoverService(targetService.source);
    const upstreamUrl = validatedService.operation_urls[operation as keyof typeof validatedService.operation_urls];
    if (!upstreamUrl) throw new Error(`Escrow service does not support ${operation}.`);
    const response = await fetch("/api/escrow", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        service_source: validatedService.source,
        operation,
        authorization: await buildNip98Authorization(identity, "POST", upstreamUrl),
        payload,
      }),
    });
    const text = await response.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Escrow service returned an invalid JSON response (HTTP ${response.status}).`);
    }

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

  async function selectDescriptor() {
    setDiscoveryBusy(true);
    setError("");

    try {
      const nextService = await discoverService({ type: "url", url: descriptorInput });
      selectService(nextService);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setDiscoveryBusy(false);
    }
  }

  async function loadEscrowCatalog() {
    setCatalogBusy(true);
    try {
      const response = await fetch("/api/escrows", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "Escrow catalog discovery failed.");
      const relayEntries = body.escrows as EscrowCatalogEntry[];
      setCatalog((current) => {
        const unique = [...current, ...relayEntries];
        return unique.filter((entry, index) =>
          unique.findIndex((candidate) =>
            (candidate.service?.endpoint || `${candidate.publisher_pubkey}:${candidate.identifier}`) ===
            (entry.service?.endpoint || `${entry.publisher_pubkey}:${entry.identifier}`),
          ) === index,
        );
      });
      setCatalogExpanded(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCatalogBusy(false);
    }
  }

  function selectService(nextService: EscrowService) {
    startNewGame();
    setService(nextService);
    setServiceSelected(true);
    setCatalogExpanded(false);
    setDescriptorInput(nextService.source.type === "url" ? nextService.source.url : "");
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
          {serviceSelected && !appSignerTrusted ? (
            <Alert severity="error">
              This escrow does not trust this Rollpot application signer. Creating a game would leave Rollpot unable to release the wager.
            </Alert>
          ) : null}
          {!serviceSelected ? <Alert severity="info">Select an escrow before creating a game.</Alert> : null}

          <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 2 }}>
            {serviceSelected && !catalogExpanded && service ? (
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                    <Chip size="small" label="selected" color="primary" />
                    <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>
                      {service.source.type === "nostr"
                        ? service.source.event.tags.find(([name]) => name === "d")?.[1] || "Nostr escrow"
                        : "Direct URL escrow"}
                    </Typography>
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {service.descriptor.escrow_type} · {service.descriptor.networks.join(", ")} · {service.descriptor.service?.interface}
                  </Typography>
                </Box>
                <Button size="small" variant="outlined" onClick={() => setCatalogExpanded(true)}>
                  Change escrow
                </Button>
              </Stack>
            ) : (
              <Stack spacing={1.5} sx={{ mb: 2 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                  <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>Available escrows</Typography>
                    <Typography variant="body2" color="text.secondary">Query PIP-01 descriptors from public Nostr relays, then select one for a new game.</Typography>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    {serviceSelected ? (
                      <Button size="small" variant="text" onClick={() => setCatalogExpanded(false)}>
                        Collapse
                      </Button>
                    ) : null}
                    <Button size="small" variant="contained" onClick={() => void loadEscrowCatalog()} disabled={catalogBusy}>
                      {catalogBusy ? "Discovering..." : "Discover escrows"}
                    </Button>
                  </Stack>
                </Stack>
                {catalogExpanded ? (
                  <Stack spacing={1}>
                    {catalog.map((entry) => {
                    const candidate = entry.service;
                    const signerTrusted = candidate ? isApplicationSignerTrusted(candidate, appSigner?.pubkey) : false;
                    const selectable = entry.compatible && Boolean(candidate) && signerTrusted;
                    const selected = Boolean(candidate && serviceSelected && service && candidate.service_id === service.service_id);
                    const reason = entry.compatibility_status === "discovery_only"
                      ? entry.compatibility_reason
                      : !entry.compatible
                      ? entry.compatibility_reason
                      : !signerTrusted
                        ? "This service does not trust the active Rollpot application signer."
                        : "Compatible with Rollpot";
                    const descriptor = entry.descriptor || candidate?.descriptor;
                    const statusLabel = entry.compatibility_status === "discovery_only"
                      ? "Discovery only"
                      : selectable
                        ? "Standalone compatible"
                        : "Standalone incompatible";
                    const statusColor = entry.compatibility_status === "discovery_only" ? "info" : selectable ? "success" : "warning";

                      return (
                        <Paper key={`${entry.publisher_pubkey}:${entry.identifier}:${entry.source.type}`} variant="outlined" sx={{ p: 1.5 }}>
                        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
                          <Box sx={{ minWidth: 0, cursor: "pointer" }} onClick={() => setDetailEntry(entry)}>
                            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                              <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>{entry.identifier}</Typography>
                              <Chip size="small" label={statusLabel} color={statusColor} />
                              {selected ? <Chip size="small" label="selected" color="primary" /> : null}
                              <Chip size="small" icon={<InfoOutlinedIcon />} label="Details" variant="outlined" onClick={() => setDetailEntry(entry)} />
                            </Stack>
                            <Typography variant="body2" color="text.secondary">
                              {descriptor?.escrow_type || "Unknown escrow type"} · {descriptor?.networks?.join(", ") || "network not declared"}
                            </Typography>
                            {entry.publisher_pubkey ? <Typography variant="caption" color="text.secondary">Publisher {shortKey(entry.publisher_pubkey)}</Typography> : null}
                            <Typography variant="caption" color={selectable ? "success.main" : "warning.main"} sx={{ display: "block" }}>{reason}</Typography>
                          </Box>
                          <Button disabled={!selectable || selected} variant={selected ? "contained" : "outlined"} onClick={() => candidate && selectService(candidate)}>
                            {selected ? "Selected" : "Select"}
                          </Button>
                        </Stack>
                        </Paper>
                      );
                    })}
                  </Stack>
                ) : null}
              </Stack>
            )}
            {(!serviceSelected || catalogExpanded) ? (
              <>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>Direct URL fallback</Typography>
                <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} sx={{ alignItems: { md: "flex-start" } }}>
                  <TextField
                    label="Escrow descriptor URL"
                    value={descriptorInput}
                    onChange={(event) => setDescriptorInput(event.target.value)}
                    size="small"
                    fullWidth
                    helperText={service ? `${service.descriptor.escrow_type} · ${service.descriptor.networks.join(", ")} · ${service.descriptor.service?.interface}` : "No escrow selected yet"}
                  />
                  <Button disabled={discoveryBusy || !descriptorInput.trim()} variant="outlined" onClick={selectDescriptor} sx={{ minWidth: 120 }}>
                    Validate URL
                  </Button>
                </Stack>
              </>
            ) : null}
          </Paper>

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
                      {requiresCounterpartyPubkey ? (
                        <TextField
                          label="Player 2 Nostr pubkey"
                          value={counterpartyPubkey}
                          onChange={(event) => setCounterpartyPubkey(event.target.value)}
                          size="small"
                          placeholder="npub1... or 64-character hex"
                          error={Boolean(counterpartyPubkeyError)}
                          helperText={counterpartyPubkeyError || "The invite will be bound to this identity."}
                        />
                      ) : null}
                      <Button
                        disabled={!canCallService || (requiresCounterpartyPubkey && (!normalizedCounterpartyPubkey || Boolean(counterpartyPubkeyError))) || busy}
                        variant="contained"
                        onClick={createEscrow}
                        startIcon={<LocalAtmIcon />}
                      >
                        Create game
                      </Button>
                      <TextField label="Invite code" value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} size="small" multiline minRows={3} />
                      <Button disabled={!canAuthenticate || !inviteInput.trim() || busy} variant="outlined" onClick={joinInvite} startIcon={<LoginIcon />}>
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
                          {trackedGames.slice(0, 4).map((game) => {
                            const expired = isGameExpired(game);
                            return (
                              <Stack key={game.id} direction="row" spacing={0.5} sx={{ alignItems: "stretch" }}>
                                <Button
                                  variant={game.id === activeGameId ? "contained" : "outlined"}
                                  color={game.release ? "success" : "primary"}
                                  onClick={() => void restoreTrackedGame(game)}
                                  sx={{ justifyContent: "flex-start", textAlign: "left", flex: 1 }}
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
                                {expired ? (
                                  <Tooltip title="Delete expired game">
                                    <Button
                                      size="small"
                                      variant="outlined"
                                      color="error"
                                      onClick={() => deleteTrackedGame(game.id)}
                                      sx={{ minWidth: 36, px: 1 }}
                                    >
                                      <DeleteIcon fontSize="small" />
                                    </Button>
                                  </Tooltip>
                                ) : null}
                              </Stack>
                            );
                          })}
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

      <EscrowDetailDialog entry={detailEntry} onClose={() => setDetailEntry(null)} appSigner={appSigner} onSelect={selectService} canSelect={(entry) => entry.compatible && Boolean(entry.service) && isApplicationSignerTrusted(entry.service!, appSigner?.pubkey)} />
    </Box>
  );
}

function EscrowDetailDialog({
  entry,
  onClose,
  appSigner,
  onSelect,
  canSelect,
}: {
  entry: EscrowCatalogEntry | null;
  onClose: () => void;
  appSigner: EscrowIdentity | null;
  onSelect: (service: EscrowService) => void;
  canSelect: (entry: EscrowCatalogEntry) => boolean;
}) {
  if (!entry) return null;

  const candidate = entry.service;
  const descriptor = entry.descriptor || candidate?.descriptor;
  const service = descriptor?.service;
  const signers = service?.decision_signers;
  const signerTrusted = candidate ? isApplicationSignerTrusted(candidate, appSigner?.pubkey) : false;
  const selectable = canSelect(entry);

  return (
    <Dialog open={Boolean(entry)} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 900 }}>{entry.identifier}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Chip size="small" label={entry.compatibility_status === "discovery_only" ? "Discovery only" : selectable ? "Standalone compatible" : "Standalone incompatible"} color={entry.compatibility_status === "discovery_only" ? "info" : selectable ? "success" : "warning"} />
            {entry.compatibility_reason ? <Typography variant="caption" color="text.secondary">{entry.compatibility_reason}</Typography> : null}
          </Stack>

          {entry.publisher_pubkey ? <DetailRow label="Publisher" value={entry.publisher_pubkey} mono /> : null}

          {descriptor ? (
            <>
              <DetailRow label="Version" value={String(descriptor.version)} />
              <DetailRow label="Escrow type" value={descriptor.escrow_type || "—"} />
              <DetailRow label="Networks" value={descriptor.networks?.join(", ") || "—"} />
              <DetailRow label="Reference format" value={descriptor.reference_format || "—"} />
              <DetailRow label="Updated at" value={descriptor.updated_at ? new Date(descriptor.updated_at * 1000).toLocaleString() : "—"} />
              <DetailRow label="Funding confirmation" value={descriptor.funding_rules?.required_confirmation || "—"} />
              <DetailRow label="Release trigger" value={descriptor.release_rules?.release_trigger || "—"} />
              <DetailRow label="Refund trigger" value={descriptor.release_rules?.refund_trigger || "—"} />
              <DetailRow label="Dispute policy" value={descriptor.dispute_rules?.policy || "—"} />
            </>
          ) : null}

          {service ? (
            <>
              <Typography variant="subtitle2" sx={{ fontWeight: 900, mt: 1 }}>Service</Typography>
              <DetailRow label="Transport" value={service.transport?.join(", ") || "—"} />
              <DetailRow label="Interface" value={service.interface || "—"} />
              <DetailRow label="Endpoint" value={service.endpoint || "—"} mono />
              <DetailRow label="Schema URL" value={service.schema_url || "—"} mono />
              <DetailRow label="Auth" value={service.auth?.join(", ") || "—"} />
              <DetailRow label="Operations" value={service.operations?.join(", ") || "—"} />
              <DetailRow label="Funding models" value={service.funding_model?.join(", ") || "—"} />
              <DetailRow label="Release decisions" value={service.release_decisions?.join(", ") || "—"} />
              <DetailRow label="Enrollment" value={candidate?.enrollment || "—"} />
            </>
          ) : null}

          {signers ? (
            <>
              <Typography variant="subtitle2" sx={{ fontWeight: 900, mt: 1 }}>Decision signers</Typography>
              {signers.operator_pubkey ? <DetailRow label="Operator pubkey" value={signers.operator_pubkey} mono /> : null}
              {signers.application_pubkeys?.length ? (
                <DetailRow
                  label="Application pubkeys"
                  value={signers.application_pubkeys.map((pk) => `${shortKey(pk)}${pk === appSigner?.pubkey ? " (your signer)" : ""}`).join(", ")}
                  mono
                />
              ) : null}
              {signers.oracle_pubkeys?.length ? <DetailRow label="Oracle pubkeys" value={signers.oracle_pubkeys.map(shortKey).join(", ")} mono /> : null}
              <Typography variant="caption" color={signerTrusted ? "success.main" : "warning.main"}>
                {signerTrusted ? "This service trusts your application signer." : "This service does not trust your application signer."}
              </Typography>
            </>
          ) : null}

          {entry.source.type === "url" ? <DetailRow label="Descriptor source" value={entry.source.url} mono /> : <DetailRow label="Descriptor source" value={`Nostr event ${shortKey(entry.source.event.id)}`} mono />}

          <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end", mt: 1 }}>
            <Button variant="text" onClick={onClose}>Close</Button>
            {selectable && candidate ? (
              <Button variant="contained" onClick={() => { onSelect(candidate); onClose(); }}>Select this escrow</Button>
            ) : null}
          </Stack>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 900, minWidth: 130, flexShrink: 0, textTransform: "uppercase" }}>{label}</Typography>
      <Typography variant="body2" sx={{ overflowWrap: "anywhere", fontFamily: mono ? "monospace" : "inherit" }}>{value}</Typography>
    </Stack>
  );
}

function baseTrackedGame({
  escrow,
  service,
  role,
  creator,
  counterparty,
}: {
  escrow: CreateEscrowResponse;
  service: EscrowService;
  role: "creator" | "counterparty";
  creator: PlayerProfile;
  counterparty: PlayerProfile | null;
}): TrackedDiceGame {
  const now = new Date().toISOString();

  return {
    id: getGameId(service.service_id, escrow.escrow_id),
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
    service,
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
      .filter((game) => game?.id && game?.escrow?.escrow_id && game?.creator_player && game?.service?.source)
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  } catch {
    return [];
  }
}

function isGameExpired(game: TrackedDiceGame) {
  if (game.release) return false;

  const counterpartyJoined = Boolean(game.counterparty_player || game.escrow.counterparty_pubkey);
  const creatorFunded = Boolean(game.creator_status?.funded || game.creator_status?.my_funded);
  const counterpartyFunded = Boolean(game.counterparty_status?.funded || game.counterparty_status?.my_funded);

  if (counterpartyJoined && creatorFunded && counterpartyFunded) return false;

  if (!counterpartyJoined) return true;

  const now = Date.now();
  const deadline = game.escrow.funding_deadline ? Date.parse(game.escrow.funding_deadline) : 0;
  const created = Date.parse(game.created_at);
  const defaultTimeoutMs = 24 * 60 * 60 * 1000;

  if (deadline && deadline > 0) return now > deadline;
  if (created && created > 0) return now > created + defaultTimeoutMs;
  return false;
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
    (invite.counterparty_pubkey != null && !/^[0-9a-f]{64}$/.test(invite.counterparty_pubkey)) ||
    !isDescriptorSource(invite.service_source) ||
    !invite.creator_player?.lightning_address
  ) {
    throw new Error("Invite code is not a valid Rollpot invite.");
  }

  return invite;
}

async function discoverService(source: EscrowService["source"]): Promise<EscrowService> {
  const response = await fetch("/api/descriptor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body?.error || "Escrow descriptor discovery failed.");
  }

  return body as EscrowService;
}

function getGameId(serviceId: string, escrowId: string) {
  return `${serviceId}#${escrowId}`;
}

function isApplicationSignerTrusted(service: EscrowService, pubkey?: string) {
  const trustedPubkeys = service.descriptor.service?.decision_signers?.application_pubkeys;
  return !trustedPubkeys?.length || Boolean(pubkey && trustedPubkeys.includes(pubkey));
}

function shortKey(pubkey: string) {
  return pubkey.length > 16 ? `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}` : pubkey;
}

function isDescriptorSource(value: unknown): value is EscrowService["source"] {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  if (value.type === "url") return "url" in value && typeof value.url === "string";
  return value.type === "nostr" && "event" in value && Boolean(value.event);
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
