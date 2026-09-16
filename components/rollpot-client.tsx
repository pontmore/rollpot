"use client";

import CasinoIcon from "@mui/icons-material/Casino";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import HistoryIcon from "@mui/icons-material/History";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LocalAtmIcon from "@mui/icons-material/LocalAtm";
import LoginIcon from "@mui/icons-material/Login";
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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { nip19, type Event, type EventTemplate } from "nostr-tools";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DiceFace } from "./dice-face";
import { FundingStatusCard, KeyValue } from "./status-card";
import {
  buildNip98Authorization,
  canEncryptInvite,
  connectNostrPlayer,
  createLocalNostrPlayer,
  decryptInvite,
  encryptInvite,
  loadCurrentPlayer,
  loadNostrProfile,
  publishPlayerProfile,
  rollDie,
  savePlayerProfile,
  signPlayerEvent,
} from "../lib/crypto";
import { bindRootProposer, createGameRecordAction, createGameRecordRoot, gameTip, GameMode, GameRecordAction, replayGameRecord, type GameRecord } from "../lib/game-record";
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
  hasReachedFundingThreshold,
  isEscrowTerminal,
  isOwnPaymentConfirmed,
} from "../lib/escrow";

const GAMES_STORAGE = "pontmore-dice-games";
const SELECTED_SERVICE_STORAGE = "pontmore-rollpot-selected-service";
type RematchInvite = { eventId: string; code: string; senderName: string; escrowId: string };

export function RollpotClient({
  initialService,
  page = "home",
  gameId,
}: {
  initialService?: EscrowService | null;
  page?: "home" | "escrows" | "games" | "game";
  gameId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profilePublishBusy, setProfilePublishBusy] = useState(false);
  const [profilePublishNotice, setProfilePublishNotice] = useState("");
  const [playMode, setPlayMode] = useState<"create" | "join">("create");
  const [escrowDetailsOpen, setEscrowDetailsOpen] = useState(false);
  const [amountSats, setAmountSats] = useState("100");
  const [gameMode, setGameMode] = useState<GameMode>(GameMode.HigherRollWins);
  const [targetValue, setTargetValue] = useState("6");
  const [counterpartyPubkey, setCounterpartyPubkey] = useState("");
  const [service, setService] = useState<EscrowService | null>(initialService ?? null);
  const [serviceSelected, setServiceSelected] = useState(Boolean(initialService));
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
  const [showIncompatibleEscrows, setShowIncompatibleEscrows] = useState(false);
  const [detailEntry, setDetailEntry] = useState<EscrowCatalogEntry | null>(null);
  const [playerIdentity, setPlayerIdentity] = useState<EscrowIdentity | null>(null);
  const [playerProfile, setPlayerProfile] = useState<PlayerProfile | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
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
  const [gameRecord, setGameRecord] = useState<GameRecord | null>(null);
  const [recordNotice, setRecordNotice] = useState("");
  const [recordSyncStage, setRecordSyncStage] = useState<"root" | "accept" | "secure" | "result" | "authorize" | "settle" | "refund" | null>(null);
  const recordSyncRef = useRef({ inFlight: false, retryAt: 0, stage: "" });
  const [trackedGames, setTrackedGames] = useState<TrackedDiceGame[]>([]);
  const [activeGameId, setActiveGameId] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [invitePreview, setInvitePreview] = useState(false);
  const [rematchInvites, setRematchInvites] = useState<RematchInvite[]>([]);
  const [showInviteFallback, setShowInviteFallback] = useState(false);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [gameMissing, setGameMissing] = useState(false);
  const validatedServiceRef = useRef<EscrowService | null>(null);
  const validatedSourceRef = useRef<string>("");
  const catalogLoadStartedRef = useRef(false);

  useEffect(() => {
    void loadCurrentPlayer()
      .then((player) => {
        if (player) {
          setPlayerIdentity(player.identity);
          setPlayerProfile(player.profile);
          hydratePublicProfile(player.identity.pubkey, player.profile.name);
        }
        setAuthLoaded(true);
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        setAuthLoaded(true);
      });
  }, []);

  useEffect(() => {
    void fetch("/api/nostr/game/result", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ ready?: boolean; signer_pubkey?: string | null }>)
      .then((capability) => {
        if (capability.ready && capability.signer_pubkey && /^[0-9a-f]{64}$/.test(capability.signer_pubkey)) {
          setAppSigner({ label: "Rollpot server", pubkey: capability.signer_pubkey, npub: nip19.npubEncode(capability.signer_pubkey) });
        }
      }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!playerIdentity || !trackedGames.length) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const knownPartners = [...new Set(trackedGames.flatMap((game) => [game.creator_player.pubkey, game.counterparty_player?.pubkey || ""]).filter((pubkey) => pubkey && pubkey !== playerIdentity.pubkey))];
        const query = new URLSearchParams({ recipient_pubkey: playerIdentity.pubkey });
        knownPartners.forEach((pubkey) => query.append("partner_pubkey", pubkey));
        trackedGames.forEach((game) => query.append("known_escrow_id", game.escrow.escrow_id));
        const response = await fetch(`/api/nostr/invites?${query}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { requests?: Array<{ event: Event; sender_pubkey: string; escrow_id: string }> };
        const pending = await Promise.all((payload.requests || []).map(async ({ event, sender_pubkey, escrow_id }) => {
          try {
            const code = await decryptInvite(playerIdentity, sender_pubkey, event.content);
            const invite = decodeInvite(code);
            if (invite.creator_player.pubkey !== sender_pubkey || invite.counterparty_pubkey !== playerIdentity.pubkey ||
              invite.escrow_id !== escrow_id ||
              invite.funding_deadline && Date.now() > Date.parse(invite.funding_deadline)) return null;
            return { eventId: event.id, code, senderName: invite.creator_player.name || "Partner", escrowId: invite.escrow_id };
          } catch { return null; }
        }));
        if (!cancelled) setRematchInvites(pending.filter((invite): invite is RematchInvite => Boolean(invite)).slice(0, 5));
      } catch { /* Manual invite sharing remains available if relays are unavailable. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [playerIdentity?.pubkey, trackedGames]);

  useEffect(() => {
    let cancelled = false;
    setEscrowDetailsOpen(false);
    const savedGames = loadTrackedGames();
    setTrackedGames(savedGames);
    if (page === "game") {
      const savedGame = savedGames.find((game) => game.escrow.escrow_id === gameId);
      setGameMissing(!savedGame);
      if (savedGame) {
        applyTrackedGame(savedGame);
        void restoreTrackedGame(savedGame, () => !cancelled);
      }
    } else {
      startNewGame();
      setGameMissing(false);
      const savedService = loadSelectedService();
      const configuredCoordinate = initialService?.source.type === "nostr" ? serviceCoordinate(initialService) : "";
      const savedUsesConfiguredCoordinate = savedService?.source.type === "nostr" && configuredCoordinate && serviceCoordinate(savedService) === configuredCoordinate;
      const preferredService = initialService && (!savedService || savedService.source.type === "url" || savedUsesConfiguredCoordinate) ? initialService : savedService || initialService;
      if (preferredService) {
        setService(preferredService);
        setServiceSelected(true);
        if (preferredService.source.type === "nostr" && savedService?.source.type === "url") window.localStorage.setItem(SELECTED_SERVICE_STORAGE, JSON.stringify(preferredService));
        if (page === "escrows") {
          setCatalog((current) => [
            {
              service: preferredService,
              descriptor: preferredService.descriptor,
              source: preferredService.source,
              publisher_pubkey: preferredService.source.type === "nostr" ? preferredService.source.event.pubkey : "",
              identifier: serviceLabel(preferredService),
              compatible: true,
              compatibility_status: "standalone_compatible",
            },
            ...current.filter((entry) => entry.service?.service_id !== preferredService.service_id),
          ]);
        }
      }
    }
    setHydrated(true);
    return () => { cancelled = true; };
  }, [page, gameId]);

  useEffect(() => {
    if (page !== "escrows" || catalogLoadStartedRef.current) return;
    catalogLoadStartedRef.current = true;
    void loadEscrowCatalog();
  }, [page]);

  useEffect(() => {
    if (playerProfile) {
      savePlayerProfile(playerProfile);
    }
  }, [playerProfile]);

  const appSignerTrusted = Boolean(appSigner);
  const coordinationReady = Boolean(appSigner && service?.source.type === "nostr");
  const canAuthenticate = Boolean(playerIdentity && playerProfile?.lightning_address);
  const canCallService = Boolean(hydrated && serviceSelected && service?.endpoint && canAuthenticate && coordinationReady && !escrow);
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
  const currentGamePlayer = localRole === "creator" ? creatorPlayer : counterpartyPlayer;
  const gameIdentityMatches = Boolean(playerIdentity && currentGamePlayer?.pubkey === playerIdentity.pubkey);
  const requiresCounterpartyBeforeFunding = true;
  const canRequestPayment = Boolean(escrow && gameIdentityMatches && (!requiresCounterpartyBeforeFunding || playerJoined));
  const paymentsReady = Boolean(hasReachedFundingThreshold(creatorStatus) || hasReachedFundingThreshold(counterpartyStatus));
  const myFunding = localRole === "creator" ? creatorFunding : counterpartyFunding;
  const myStatus = localRole === "creator" ? creatorStatus : counterpartyStatus;
  const technicalStatus = myStatus || creatorStatus || counterpartyStatus;
  const gamePlayer2 = counterpartyPlayer?.pubkey || escrow?.counterparty_pubkey || creatorStatus?.counterparty_pubkey || trackedGames.find((game) => game.id === activeGameId)?.preferred_partner_pubkey || "";
  const rematchPartnerPubkey = localRole === "creator" ? gamePlayer2 : creatorPlayer?.pubkey || "";
  const knownRematchPartner = trackedGames.flatMap((game) => [game.creator_player, game.counterparty_player]).find((player) => player?.pubkey === rematchPartnerPubkey) || null;
  const rematchPartnerName = localRole === "creator" ? counterpartyPlayer?.name || knownRematchPartner?.name || "Player 2" : creatorPlayer?.name || knownRematchPartner?.name || "Player 1";
  const ownPaymentConfirmed = isOwnPaymentConfirmed(myStatus);
  const ownGameAcceptance = Boolean(playerIdentity && gameRecord?.accepted.has(playerIdentity.pubkey));
  const gameEnded = Boolean(releaseResponse || gameRecord?.settlement || gameRecord?.refund || (!gameRecord && isEscrowTerminal(technicalStatus)));
  const currentGame = gameRecord;
  const selectedMode = currentGame?.mode || gameMode;
  const selectedTarget = currentGame?.target ?? (gameMode === GameMode.RollToTarget ? Number(targetValue) : undefined);
  const modeTerms = { game_mode: selectedMode, target: selectedMode === GameMode.RollToTarget ? selectedTarget : undefined };
  const currentPair = currentGame?.rolls.get(currentGame.currentRound);
  const previousRounds = currentGame
    ? [...currentGame.rolls.entries()].filter(([round, pair]) => round < currentGame.currentRound && pair.creator && pair.counterparty).sort(([a], [b]) => a - b)
    : [];
  const ownRoll = localRole === "creator" ? currentPair?.creator : currentPair?.counterparty;
  const canRoll = Boolean(paymentsReady && currentGame?.secured && !currentGame.pendingResult && !ownRoll && !gameEnded && gameIdentityMatches && (localRole === "creator" || currentPair?.creator));
  const readyToRoll = Boolean(canRoll);
  const sharedWinner = currentGame?.result || currentGame?.pendingResult;
  const displayedRolls = sharedWinner || gameResult;
  const gameStatusLine = recordNotice || releaseResponse ? ""
    : sharedWinner
      ? `${creatorPlayer?.name || "Player 1"} rolled ${sharedWinner.creator_roll}; ${counterpartyPlayer?.name || "Player 2"} rolled ${sharedWinner.counterparty_roll}. ${sharedWinner.winner === "creator" ? creatorPlayer?.name || "Player 1" : counterpartyPlayer?.name || "Player 2"} wins ${selectedMode === GameMode.RollToTarget ? `by hitting ${selectedTarget}` : selectedMode === GameMode.LowerRollWins ? "with the lower roll" : "with the higher roll"}.`
    : gameEnded && !releaseResponse
      ? `The escrow is ${technicalStatus?.state || "closed"}. See escrow details.`
      : recordSyncStage === "root"
          ? "Sharing game…"
          : recordSyncStage === "secure"
            ? "Confirming the secured pot…"
          : recordSyncStage === "result"
            ? "Sharing the result…"
          : recordSyncStage === "authorize"
            ? "Authorizing the winner payout…"
          : recordSyncStage === "settle"
            ? "Confirming the winner payout…"
          : recordSyncStage === "refund"
            ? "Confirming the escrow refund…"
          : recordSyncStage === "accept"
            ? "Sharing your confirmation…"
            : playerJoined && !currentGame && localRole === "counterparty"
              ? `Waiting for ${creatorPlayer?.name || "Player 1"}'s game record.`
              : paymentsReady && currentGame && currentGame.accepted.size !== 2
                ? "Waiting for both game confirmations…"
                : paymentsReady && ownRoll
                  ? `You rolled. Waiting for ${localRole === "creator" ? counterpartyPlayer?.name || "Player 2" : creatorPlayer?.name || "Player 1"} to roll.`
                  : paymentsReady && currentGame?.currentRound && currentGame.currentRound > 1 && !currentPair
                    ? "No winner this round. Both players roll again."
                  : paymentsReady && currentGame?.accepted.size === 2 && localRole === "counterparty" && !currentPair?.creator
                    ? `Waiting for ${creatorPlayer?.name || "Player 1"} to roll.`
                  : "";
  const gameHeaderStatus = playerJoined && !paymentsReady && !gameEnded && gameStatusLine
    ? gameStatusLine
    : gameEnded ? "Ended"
      : !playerJoined ? "Waiting for Player 2"
        : sharedWinner ? "Winner decided"
          : paymentsReady ? "Fully funded"
            : "Funding";
  const allPaid = Boolean(escrow?.funding_model === "2_of_2" && (paymentsReady || releaseResponse?.state === "released" || technicalStatus?.state === "released"));
  const fundedCounts = [creatorStatus?.funded_count, counterpartyStatus?.funded_count].filter((count): count is number => count != null);
  const fundedCount = fundedCounts.length ? Math.max(...fundedCounts) : null;
  const fundingThreshold = technicalStatus?.funding_threshold ?? escrow?.funding_threshold ?? 2;
  const inviteFundingDeadline = trackedGames.find((game) => game.id === activeGameId)?.invite_funding_deadline;
  const fundingDeadline = Date.parse(escrow?.funding_deadline || inviteFundingDeadline || "");
  const canCancelEscrow = Boolean(escrow && !gameEnded && gameIdentityMatches && (
    technicalStatus?.state === "created" && localRole === "creator" ||
    technicalStatus?.state === "partially_funded" && Number.isFinite(fundingDeadline) && Date.now() > fundingDeadline
  ));
  const canRequestRefund = Boolean(currentGame && gameIdentityMatches && !gameEnded && !currentGame.settlementAuthorization && !currentGame.refundAuthorization && Date.now() / 1000 >= currentGame.terms.recover_by);
  const playableEscrows = catalog.filter((entry) => entry.source.type === "nostr" && entry.compatible && Boolean(entry.service));
  const incompatibleEscrows = catalog.filter((entry) => !playableEscrows.includes(entry));
  const incompatibleEscrowCount = incompatibleEscrows.length;
  const showFundingCard = Boolean(playerJoined && !paymentsReady && !gameEnded);
  const escrowStateSummary = `${releaseResponse?.state || technicalStatus?.state || escrow?.state || "unknown"}${showFundingCard ? "" : fundedCount != null ? ` · ${fundedCount}/${fundingThreshold} funded` : allPaid ? " · fully funded" : ""}`;
  const preferredPartnerPubkey = trackedGames.find((game) => game.id === activeGameId)?.preferred_partner_pubkey;
  const inviteCode = useMemo(() => {
    if (!escrow || localRole !== "creator" || !creatorPlayer || !service || releaseResponse) {
      return "";
    }

    const enrollment = escrow.enrollments?.[0];

    if (!enrollment) {
      return "";
    }

    return encodeInvite({
      version: 2,
      game: "rollpot",
      game_mode: gameMode,
      ...(gameMode === GameMode.RollToTarget ? { target: Number(targetValue) } : {}),
      escrow_id: escrow.escrow_id,
      enrollment_token: enrollment.enrollment_token,
      counterparty_pubkey: enrollment.participant_pubkey || preferredPartnerPubkey,
      amount_sats: escrow.amount_sats,
      funding_model: escrow.funding_model,
      creator_player: creatorPlayer,
      created_at: new Date().toISOString(),
      funding_deadline: escrow.funding_deadline,
      service_source: service.source,
    });
  }, [creatorPlayer, escrow, localRole, releaseResponse, service?.source, gameMode, targetValue, preferredPartnerPubkey]);

  useEffect(() => {
    if (!escrow || !playerIdentity || !service || !gameIdentityMatches || gameEnded) {
      return;
    }

    const controller = new AbortController();
    const identity = playerIdentity;
    const selectedService = service;
    const escrowId = escrow.escrow_id;

    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const authorization = await buildNip98Authorization(
            identity,
            "POST",
            selectedService.operation_urls.fund_status,
          );
          const response = await fetch("/api/escrow/events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              service_source: selectedService.source,
              escrow_id: escrowId,
              authorization,
            }),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error("Escrow event stream unavailable.");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let frameEnd = buffer.indexOf("\n\n");
              while (frameEnd !== -1) {
                const frame = buffer.slice(0, frameEnd);
                buffer = buffer.slice(frameEnd + 2);
                const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
                const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
                if (event === "status" && data) {
                  const status = JSON.parse(data) as FundStatusResponse;
                  if (status.escrow_id === escrowId && !controller.signal.aborted) {
                    if (localRole === "creator") setCreatorStatus(status);
                    else setCounterpartyStatus(status);
                    const saved = loadTrackedGames().find((game) => game.id === getGameId(selectedService.service_id, escrowId));
                    const statusKey = localRole === "creator" ? "creator_status" : "counterparty_status";
                    if (saved && JSON.stringify(saved[statusKey]) !== JSON.stringify(status)) {
                      saveTrackedGame({ ...saved, [statusKey]: status, updated_at: new Date().toISOString() });
                    }
                  }
                } else if (event === "error") {
                  throw new Error("Escrow event stream interrupted.");
                }
                frameEnd = buffer.indexOf("\n\n");
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        } catch {
          // Manual status checks still surface service errors to the player.
        }

        if (!controller.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    })();

    return () => controller.abort();
  }, [escrow, gameEnded, gameIdentityMatches, localRole, playerIdentity, service]);

  useEffect(() => {
    if (page !== "game" || !escrow) return;
    let cancelled = false;
    const participants = [
      { role: "creator_player" as const, pubkey: creatorPlayer?.pubkey },
      { role: "counterparty_player" as const, pubkey: counterpartyPlayer?.pubkey || creatorStatus?.counterparty_pubkey || escrow.counterparty_pubkey },
    ];
    for (const { role, pubkey } of participants) {
      if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) continue;
      void loadNostrProfile(pubkey).then((metadata) => {
        if (cancelled || !metadata || typeof metadata.name !== "string" || !metadata.name.trim()) return;
        const saved = loadTrackedGames().find((game) => game.escrow.escrow_id === escrow.escrow_id);
        if (!saved) return;
        const previous = saved[role];
        const profile: PlayerProfile = {
          name: metadata.name,
          pubkey,
          npub: previous?.npub || nip19.npubEncode(pubkey),
          lightning_address: previous?.lightning_address || (typeof metadata.lud16 === "string" ? metadata.lud16 : ""),
        };
        if (previous?.name === profile.name && previous?.pubkey === pubkey) return;
        if (role === "creator_player") setCreatorPlayer(profile);
        else setCounterpartyPlayer(profile);
        saveTrackedGame({ ...saved, [role]: profile, updated_at: new Date().toISOString() });
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [page, escrow?.escrow_id, escrow?.counterparty_pubkey, creatorStatus?.counterparty_pubkey, creatorPlayer?.pubkey, counterpartyPlayer?.pubkey]);

  useEffect(() => {
    if (page !== "game" || !escrow || !service || !appSigner || !creatorPlayer?.pubkey || !gamePlayer2) return;
    let cancelled = false;
    const expected = {
      escrow_id: escrow.escrow_id,
      service_id: service.service_id,
      amount_sats: escrow.amount_sats,
      player1: creatorPlayer.pubkey,
      player2: gamePlayer2,
      ...modeTerms,
      ...coordinationBinding(service, appSigner.pubkey),
    };
    const refresh = async () => {
      try {
        const published = await loadPublishedGame(expected);
        if (!cancelled) {
          setGameRecord((current) => !published ? current
            : current?.root.id === published.root.id && current.actions.length > published.actions.length ? current : published);
          setRecordNotice("");
        }
      } catch (error) {
        if (!cancelled) setRecordNotice(error instanceof Error ? error.message : "Could not load the shared game record.");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [page, escrow?.escrow_id, escrow?.amount_sats, service?.service_id, appSigner?.pubkey, creatorPlayer?.pubkey, gamePlayer2, modeTerms.game_mode, modeTerms.target]);

  useEffect(() => {
    if (page !== "game" || !escrow || !service || !playerIdentity || !gameIdentityMatches || gameEnded || busy) return;
    const stage = !currentGame && playerJoined && gamePlayer2 && localRole === "creator"
      ? "root"
      : currentGame && ownPaymentConfirmed && !ownGameAcceptance && (localRole === "creator" || currentGame.accepted.has(currentGame.root.pubkey))
        ? "accept"
        : currentGame?.refundAuthorization && !currentGame.refund
          ? "refund"
        : currentGame && currentGame.accepted.size === 2 && !currentGame.secured && localRole === "creator"
          ? "secure"
          : currentGame?.pendingResult && !currentGame.result && localRole === "creator"
            ? "result"
          : currentGame?.result && !currentGame.settlementAuthorization && localRole === "creator"
            ? "authorize"
            : currentGame?.settlementAuthorization && !currentGame.settlement && localRole === "creator"
                ? "settle"
                : null;
    if (!stage) return;

    let cancelled = false;
    const sync = async () => {
      const pending = recordSyncRef.current;
      const stageKey = `${escrow.escrow_id}:${stage}:${gameRecord?.root.id || ""}`;
      if (pending.inFlight || pending.stage === stageKey && Date.now() < pending.retryAt) return;
      pending.inFlight = true;
      pending.stage = stageKey;
      pending.retryAt = Date.now() + 10_000;
      setRecordSyncStage(stage);
      try {
        if (stage === "root") await publishGameRoot();
        else if (stage === "accept") await acceptPublishedGame();
        else if (stage === "secure") await securePublishedGame();
        else if (stage === "result") await publishSharedResult();
        else if (stage === "authorize") await authorizePublishedResult();
        else if (stage === "settle") await settlePublishedGame();
        else await refundPublishedGame();
        if (!cancelled) setRecordNotice("");
      } catch (error) {
        if (!cancelled) setRecordNotice(error instanceof Error ? error.message : "Could not update the shared game.");
      } finally {
        pending.inFlight = false;
        setRecordSyncStage(null);
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [page, escrow?.escrow_id, service?.service_id, playerIdentity, gameIdentityMatches, gameEnded, busy,
    gameRecord?.root.id, gameRecord?.version, gameRecord?.accepted.size, gameRecord?.secured, gameRecord?.pendingResult?.round, gameRecord?.result?.event.id, gameRecord?.settlementAuthorization?.id, gameRecord?.settlement?.id, gameRecord?.refundAuthorization?.id, gameRecord?.refund?.id,
    ownPaymentConfirmed, ownGameAcceptance, playerJoined, localRole,
    gamePlayer2]);

  useEffect(() => {
    if (page !== "game" || !currentGame?.result || gameEnded || !escrow || !playerIdentity || !gameIdentityMatches) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await callEscrow<FundStatusResponse>(playerIdentity, "fund_status", { escrow_id: escrow.escrow_id });
        if (cancelled || status.escrow_id !== escrow.escrow_id || !isEscrowTerminal(status)) return;
        if (localRole === "creator") { setCreatorStatus(status); saveCurrentGame({ creator_status: status }); }
        else { setCounterpartyStatus(status); saveCurrentGame({ counterparty_status: status }); }
      } catch { /* The shared result remains visible while escrow status is temporarily unavailable. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [page, currentGame?.result?.event.id, gameEnded, escrow?.escrow_id, playerIdentity?.pubkey, gameIdentityMatches, localRole]);

  async function createEscrow() {
    if (!playerIdentity || !playerProfile) return;
    assertPlayableProfile(playerProfile);
    const participantPubkey = normalizeNostrPubkey(counterpartyPubkey);

    if (requiresCounterpartyPubkey && !participantPubkey) {
      setError("Enter Player 2's npub or 64-character hex Nostr public key.");
      return;
    }

    if (requiresCounterpartyPubkey && participantPubkey === playerIdentity.pubkey) {
      setError("Player 2 must use a different Nostr identity.");
      return;
    }

    await startGameWithPartner({
      amount: Number(amountSats),
      partnerPubkey: participantPubkey || "",
      mode: gameMode,
      target: gameMode === GameMode.RollToTarget ? Number(targetValue) : undefined,
      targetService: service!,
    });
  }

  async function playAgain() {
    if (!escrow || !service || !playerIdentity || !playerProfile || !rematchPartnerPubkey || !gameIdentityMatches) return;
    assertPlayableProfile(playerProfile);
    if (rematchPartnerPubkey === playerIdentity.pubkey) { setError("A rematch needs another player."); return; }
    await startGameWithPartner({
      amount: escrow.amount_sats,
      partnerPubkey: rematchPartnerPubkey,
      mode: selectedMode,
      target: selectedMode === GameMode.RollToTarget ? selectedTarget : undefined,
      targetService: service,
      deliverRematchInvite: true,
    });
  }

  async function startGameWithPartner({ amount, partnerPubkey, mode, target, targetService, deliverRematchInvite = false }: {
    amount: number;
    partnerPubkey: string;
    mode: GameMode;
    target?: number;
    targetService: EscrowService;
    deliverRematchInvite?: boolean;
  }) {
    if (!playerIdentity || !playerProfile) return;
    await runOperation(async () => {
      const created = await callEscrow<CreateEscrowResponse>(playerIdentity, "create", {
        amount_sats: amount,
        description: "Rollpot wager",
        refund_ln_address: playerProfile.lightning_address,
        ...(targetService.enrollment === "predeclared_pubkey" ? { participant_pubkeys: [partnerPubkey] } : {}),
        funding_model: "2_of_2",
        idempotency_key: crypto.randomUUID(),
      }, targetService);
      let inviteDelivery: "nostr" | "manual" = "manual";
      if (deliverRematchInvite && partnerPubkey && created.enrollments?.[0]?.enrollment_token && canEncryptInvite(playerIdentity)) {
        const inviteCode = encodeInvite({
          version: 2, game: "rollpot", game_mode: mode,
          ...(mode === GameMode.RollToTarget ? { target } : {}),
          escrow_id: created.escrow_id,
          enrollment_token: created.enrollments[0].enrollment_token,
          counterparty_pubkey: partnerPubkey,
          amount_sats: created.amount_sats,
          funding_model: created.funding_model,
          creator_player: playerProfile,
          created_at: new Date().toISOString(),
          funding_deadline: created.funding_deadline,
          service_source: targetService.source,
        });
        try {
          const ciphertext = await encryptInvite(playerIdentity, partnerPubkey, inviteCode);
          const event = await signPlayerEvent(playerIdentity, {
            kind: 78, created_at: Math.floor(Date.now() / 1000),
            tags: [["d", `rollpot/rematch/v1:${created.escrow_id}`], ["p", partnerPubkey]],
            content: ciphertext,
          });
          const response = await fetch("/api/nostr/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event }) });
          const outcome = await response.json() as { event_id?: string; error?: string };
          if (!response.ok || outcome.event_id !== event.id) throw new Error(outcome.error || "Could not send the rematch invite.");
          inviteDelivery = "nostr";
        } catch { /* Keep the escrow and show its manual invite code. */ }
      }
      const game = { ...baseTrackedGame({
        escrow: created,
        service: targetService,
        role: "creator",
        creator: playerProfile,
        counterparty: trackedGames.flatMap((game) => [game.creator_player, game.counterparty_player]).find((player) => player?.pubkey === partnerPubkey) || null,
        mode,
        target,
        preferredPartnerPubkey: partnerPubkey || undefined,
      }), ...(deliverRematchInvite ? { invite_delivery: inviteDelivery } : {}) };
      startNewGame();
      applyTrackedGame(game);
      saveTrackedGame(game);
      router.push(gamePath(game));
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
      setProfilePublishNotice("");
      hydratePublicProfile(player.identity.pubkey, player.profile.name);
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
      setProfilePublishNotice("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function joinInvite(code = inviteInput) {
    if (!playerIdentity || !playerProfile) return;
    if (!appSignerTrusted) { setError("Rollpot's server signing key must be configured before joining a funded game."); return; }
    assertPlayableProfile(playerProfile);

    let invite: GameInvite;
    try { invite = decodeInvite(code); }
    catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Invite code is not valid.");
      return;
    }

    if (invite.counterparty_pubkey && invite.counterparty_pubkey !== playerIdentity.pubkey) {
      setError("This invite is bound to a different Nostr identity.");
      return;
    }

    if (invite.creator_player.pubkey === playerIdentity.pubkey) {
      setError("You cannot join your own game. Use a different Nostr identity than the creator.");
      return;
    }

    await runOperation(async () => {
      const inviteService = await discoverService(invite.service_source);
      if (inviteService.source.type !== "nostr") throw new Error("This invite does not pin a signed PIP-01 escrow descriptor.");
      const joined = await callEscrow<CreateEscrowResponse>(playerIdentity, "create", {
        enrollment_token: invite.enrollment_token,
        refund_ln_address: playerProfile.lightning_address,
      }, inviteService);
      if (joined.escrow_id !== invite.escrow_id) throw new Error("Joined escrow did not match the invite.");
      if (joined.creator_pubkey !== invite.creator_player.pubkey || joined.amount_sats !== invite.amount_sats || joined.funding_model !== invite.funding_model) throw new Error("Joined escrow terms did not match the invite.");
      const game = { ...baseTrackedGame({
        escrow: joined,
        service: inviteService,
        role: "counterparty",
        creator: invite.creator_player,
        counterparty: playerProfile,
        mode: invite.game_mode || GameMode.HigherRollWins,
        target: invite.target,
      }), invite_funding_deadline: invite.funding_deadline };

      applyTrackedGame(game);
      saveTrackedGame(game);
      setRematchInvites((current) => current.filter((request) => request.escrowId !== invite.escrow_id));
      setInviteInput("");
      setInvitePreview(false);
      router.push(gamePath(game));
    });
  }

  async function publishGameRoot() {
    if (!escrow || !service || !appSigner || !playerIdentity || !creatorPlayer || !gamePlayer2 || localRole !== "creator" || !gameIdentityMatches) return;
    if (service.source.type !== "nostr") throw new Error("A PIP-02 game must pin a signed PIP-01 descriptor event.");
    const expected = { escrow_id: escrow.escrow_id, service_id: service.service_id, amount_sats: escrow.amount_sats, player1: creatorPlayer.pubkey, player2: gamePlayer2, ...modeTerms, ...coordinationBinding(service, appSigner.pubkey) };
    const existing = await loadPublishedGame(expected);
    if (existing) { setGameRecord(existing); return; }
    const status = await callEscrow<FundStatusResponse>(playerIdentity, "fund_status", { escrow_id: escrow.escrow_id });
    if (status.escrow_id !== escrow.escrow_id || (status.total_funders ?? 0) < 2 || (status.counterparty_pubkey && status.counterparty_pubkey !== gamePlayer2)) throw new Error("The escrow has not confirmed two registered funders.");
    if (status.counterparty_pubkey !== gamePlayer2 && escrow.counterparty_pubkey !== gamePlayer2) throw new Error("The escrow has not confirmed Player 2's identity.");
    const fundBy = Math.floor(Date.parse(escrow.funding_deadline || "") / 1000);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(fundBy) || fundBy <= now + 1) throw new Error("The escrow funding deadline is too close to create a coordination.");
    const descriptorD = service.source.event.tags.find((tag) => tag[0] === "d")?.[1];
    if (!descriptorD) throw new Error("The escrow descriptor has no stable address.");
    const rootCreatedAt = recordCreatedAt(escrow.escrow_id, playerIdentity.pubkey, GameRecordAction.Root);
    if (service.source.event.created_at > rootCreatedAt) throw new Error("The pinned escrow descriptor was published after this game root.");
    if (service.descriptor.expires_at !== undefined && service.descriptor.expires_at <= rootCreatedAt) throw new Error("The pinned escrow descriptor has expired.");
    const template = createGameRecordRoot({
      escrow_id: escrow.escrow_id,
      service_id: service.service_id,
      amount_sats: escrow.amount_sats,
      counterparty_pubkey: gamePlayer2,
      escrow_authority_pubkey: appSigner.pubkey,
      descriptor_event_id: service.source.event.id,
      descriptor_address: `30361:${service.source.event.pubkey}:${descriptorD}`,
      game_mode: gameMode,
      ...(gameMode === GameMode.RollToTarget ? { target: Number(targetValue) } : {}),
      expires_at: Math.min(fundBy - 1, now + 600),
      fund_by: fundBy,
      result_by: fundBy + 3600,
      recover_by: fundBy + 7200,
    }, rootCreatedAt);
    const event = await publishPlayerGameEvent(playerIdentity, bindRootProposer(template, playerIdentity.pubkey));
    setGameRecord(replayGameRecord([event], expected));
  }

  async function acceptPublishedGame() {
    if (!escrow || !playerIdentity || !currentGame || !creatorPlayer || !gamePlayer2 || !gameIdentityMatches) return;
    const status = await callEscrow<FundStatusResponse>(playerIdentity, "fund_status", { escrow_id: escrow.escrow_id });
    if (status.escrow_id !== escrow.escrow_id || !isOwnPaymentConfirmed(status)) throw new Error("The escrow has not confirmed your payment.");
    if (!service || !appSigner) return;
    const expected = { escrow_id: escrow.escrow_id, service_id: service.service_id, amount_sats: escrow.amount_sats, player1: creatorPlayer.pubkey, player2: gamePlayer2, ...modeTerms, ...coordinationBinding(service, appSigner.pubkey) };
    const latest = await loadPublishedGame(expected, currentGame.root.id);
    if (!latest || latest.root.id !== currentGame.root.id) throw new Error("The shared game root is unavailable or has changed.");
    if (latest.accepted.has(playerIdentity.pubkey)) { setGameRecord(latest); return; }
    if (service.source.type !== "nostr" || service.source.event.id !== latest.terms.descriptor_event_id || service.source.event.created_at > latest.root.created_at) throw new Error("The pinned escrow descriptor is invalid for this game.");
    const acceptedAt = recordCreatedAt(escrow.escrow_id, playerIdentity.pubkey, GameRecordAction.Accept, latest.root.id, gameTip(latest).created_at);
    if (service.descriptor.expires_at !== undefined && service.descriptor.expires_at <= acceptedAt) throw new Error("The pinned escrow descriptor expired before acceptance.");
    const event = await publishPlayerGameEvent(playerIdentity, createGameRecordAction(latest.root, GameRecordAction.Accept, {}, acceptedAt, gameTip(latest)), [latest.root, ...latest.actions]);
    setGameRecord(replayGameRecord([latest.root, ...latest.actions, event], expected));
  }

  async function publishSharedResult() {
    if (!escrow || !service || !playerIdentity || !creatorPlayer || !gamePlayer2 || !currentGame?.pendingResult || localRole !== "creator" || !gameIdentityMatches) return;
    if (!appSigner) return;
    const expected = { escrow_id: escrow.escrow_id, service_id: service.service_id, amount_sats: escrow.amount_sats, player1: creatorPlayer.pubkey, player2: gamePlayer2, ...modeTerms, ...coordinationBinding(service, appSigner.pubkey) };
    const published = await loadPublishedGame(expected, currentGame.root.id, undefined, true);
    // A relay may expose the root before its action index catches up. Combine only signed
    // events already replayed on this page; replay still rejects forks and duplicate rolls.
    const latest = published
      ? replayGameRecord([published.root, ...published.actions, currentGame.root, ...currentGame.actions], expected)!
      : currentGame;
    if (latest.root.id !== currentGame.root.id) throw new Error("The shared game root has changed.");
    if (!latest.result && !latest.pendingResult) throw new Error("Both signed rolls are not available yet.");
    const event = latest.result?.event || await publishPlayerGameEvent(playerIdentity, createGameRecordAction(latest.root, GameRecordAction.Result, latest.pendingResult!, resultRecordTime(latest, playerIdentity.pubkey), gameTip(latest)), [latest.root, ...latest.actions]);
    const updated = replayGameRecord([latest.root, ...latest.actions, event], expected);
    if (!updated?.result) throw new Error("The signed result was not recorded.");
    setGameRecord(updated);
  }

  async function securePublishedGame() {
    if (!escrow || !service || !playerIdentity || !currentGame || localRole !== "creator") return;
    const outcome = await publishServerGameAuthority(playerIdentity, service, "secure", [currentGame.root, ...currentGame.actions]);
    if (!outcome.authority_event) throw new Error("Rollpot did not publish core/secure.");
    const expected = expectedGame(escrow, service, currentGame, appSigner?.pubkey || "");
    setGameRecord(replayGameRecord([currentGame.root, ...currentGame.actions, outcome.authority_event], expected));
  }

  async function authorizePublishedResult() {
    if (!escrow || !playerIdentity || !currentGame?.result || localRole !== "creator") return;
    const event = await publishPlayerGameEvent(playerIdentity, createGameRecordAction(currentGame.root, GameRecordAction.AuthorizeSettlement, { evidence: [{ type: "event", value: currentGame.result.event.id }] }, recordCreatedAt(escrow.escrow_id, playerIdentity.pubkey, GameRecordAction.AuthorizeSettlement, currentGame.root.id, gameTip(currentGame).created_at), gameTip(currentGame)), [currentGame.root, ...currentGame.actions]);
    const expected = expectedGame(escrow, service!, currentGame, appSigner?.pubkey || "");
    setGameRecord(replayGameRecord([currentGame.root, ...currentGame.actions, event], expected));
  }

  async function settlePublishedGame() {
    if (!escrow || !service || !playerIdentity || !currentGame?.settlementAuthorization || localRole !== "creator" || !gameIdentityMatches) return;
    const outcome = await publishServerGameAuthority(playerIdentity, service, "settle", [currentGame.root, ...currentGame.actions], { creator: creatorPlayer?.name, counterparty: counterpartyPlayer?.name });
    const next = outcome.authority_event ? replayGameRecord([currentGame.root, ...currentGame.actions, outcome.authority_event], expectedGame(escrow, service, currentGame, appSigner?.pubkey || ""))! : currentGame;
    applyServerResultOutcome(outcome, next);
  }

  async function requestGameRefund() {
    if (!escrow || !service || !playerIdentity || !currentGame || !gameIdentityMatches || currentGame.settlementAuthorization || Date.now() / 1000 < currentGame.terms.recover_by) return;
    await runOperation(async () => {
      const latest = await loadPublishedGame(expectedGame(escrow, service, currentGame, appSigner?.pubkey || ""), currentGame.root.id, undefined, false, currentGame);
      if (!latest || latest.settlement || latest.refund || latest.settlementAuthorization) throw new Error("This game can no longer enter refund recovery.");
      if (latest.refundAuthorization) { setGameRecord(latest); return; }
      const event = await publishPlayerGameEvent(playerIdentity, createGameRecordAction(latest.root, GameRecordAction.AuthorizeRefund, { evidence: [{ type: "opaque", value: `recover_by:${latest.terms.recover_by}` }] }, Math.max(Math.floor(Date.now() / 1000), latest.terms.recover_by, gameTip(latest).created_at), gameTip(latest)), [latest.root, ...latest.actions]);
      setGameRecord(replayGameRecord([latest.root, ...latest.actions, event], expectedGame(escrow, service, latest, appSigner?.pubkey || "")));
    });
  }

  async function refundPublishedGame() {
    if (!escrow || !service || !playerIdentity || !currentGame?.refundAuthorization || currentGame.settlementAuthorization || !gameIdentityMatches) return;
    const outcome = await publishServerGameAuthority(playerIdentity, service, "refund", [currentGame.root, ...currentGame.actions]);
    if (!outcome.authority_event) throw new Error(outcome.settlement_error || "The escrow refund still needs reconciliation.");
    setGameRecord(replayGameRecord([currentGame.root, ...currentGame.actions, outcome.authority_event], expectedGame(escrow, service, currentGame, appSigner?.pubkey || "")));
  }

  function applyServerResultOutcome(outcome: ServerGameResultOutcome, record: GameRecord) {
    setGameRecord(record);
    if (outcome.result) setGameResult(outcome.result);
    if (outcome.release && outcome.authority_event) {
      setReleaseResponse(outcome.release);
      saveCurrentGame({ result: outcome.result || gameResult, release: outcome.release });
    }
    if (outcome.settlement_error) throw new Error(outcome.settlement_error);
  }

  async function rollMyDie() {
    if (!escrow || !service || !playerIdentity || !creatorPlayer || !gamePlayer2 || !currentGame || !gameIdentityMatches) return;
    await runOperation(async () => {
      const status = await callEscrow<FundStatusResponse>(playerIdentity, "fund_status", { escrow_id: escrow.escrow_id });
      if (status.escrow_id !== escrow.escrow_id || !hasReachedFundingThreshold(status) || !isOwnPaymentConfirmed(status)) throw new Error("The escrow has not confirmed both payments and your stake.");
      if (!appSigner) throw new Error("Rollpot's coordination signer is unavailable.");
      const expected = { escrow_id: escrow.escrow_id, service_id: service.service_id, amount_sats: escrow.amount_sats, player1: creatorPlayer.pubkey, player2: gamePlayer2, ...modeTerms, ...coordinationBinding(service, appSigner.pubkey) };
      // A relay can return the newer rolls before its action index returns the older
      // acceptances. Reconcile that view with the signed events already replayed here.
      const latest = await loadPublishedGame(expected, currentGame.root.id, (record) => record.accepted.size === 2, false, currentGame);
      if (!latest || latest.root.id !== currentGame.root.id || !latest.secured) throw new Error("Rollpot has not recorded core/secure for both funded players.");
      if (latest.pendingResult || latest.result) { setGameRecord(latest); return; }
      const round = latest.currentRound;
      const pair = latest.rolls.get(round);
      const prior = localRole === "creator" ? pair?.creator : pair?.counterparty;
      if (prior) { setGameRecord(latest); return; }
      if (localRole === "counterparty" && !pair?.creator) throw new Error("Player 1 rolls first in each round.");
      const value = savedRollValue(escrow.escrow_id, playerIdentity.pubkey, latest.root.id, round);
      const latestTime = Math.max(latest.root.created_at, ...latest.actions.map((action) => action.created_at));
      const event = await publishPlayerGameEvent(playerIdentity, createGameRecordAction(latest.root, GameRecordAction.Roll, {
        round, value,
      }, recordCreatedAt(escrow.escrow_id, playerIdentity.pubkey, GameRecordAction.Roll, `${latest.root.id}:${round}`, latestTime), gameTip(latest)), [latest.root, ...latest.actions]);
      setGameRecord(replayGameRecord([latest.root, ...latest.actions, event], expected));
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

  async function cancelUnfinishedGame() {
    if (!escrow || !playerIdentity || !gameIdentityMatches) return;
    await runOperation(async () => {
      const status = await callEscrow<FundStatusResponse>(playerIdentity, "fund_status", { escrow_id: escrow.escrow_id });
      const deadline = Date.parse(escrow.funding_deadline || inviteFundingDeadline || "");
      const allowed = status.escrow_id === escrow.escrow_id && (
        status.state === "created" && localRole === "creator" ||
        status.state === "partially_funded" && Number.isFinite(deadline) && Date.now() > deadline
      );
      if (!allowed) throw new Error("The escrow is not eligible for cancellation. Check its current funding state.");
      const cancelled = await callEscrow<{ escrow_id: string; state: "canceled" }>(playerIdentity, "cancel", { escrow_id: escrow.escrow_id });
      if (cancelled.escrow_id !== escrow.escrow_id || cancelled.state !== "canceled") throw new Error("The escrow did not confirm cancellation.");
      const finalStatus = await callEscrow<FundStatusResponse>(playerIdentity, "fund_status", { escrow_id: escrow.escrow_id });
      if (finalStatus.escrow_id !== escrow.escrow_id || finalStatus.state !== "canceled") throw new Error("The escrow outcome needs reconciliation before it is shown as canceled.");
      if (localRole === "creator") { setCreatorStatus(finalStatus); saveCurrentGame({ creator_status: finalStatus }); }
      else { setCounterpartyStatus(finalStatus); saveCurrentGame({ counterparty_status: finalStatus }); }
    });
  }

  function updatePlayerProfile(update: Partial<PlayerProfile>) {
    setProfilePublishNotice("");
    setProfileEditing(true);
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

  function hydratePublicProfile(pubkey: string, initialName: string) {
    void loadNostrProfile(pubkey).then((metadata) => {
      if (!metadata) return;
      const publicName = typeof metadata.name === "string" && metadata.name.trim() ? metadata.name : "";
      setPlayerProfile((current) => {
        if (!current || current.pubkey !== pubkey) return current;
        return {
          ...current,
          name: current.name === initialName && publicName ? publicName : current.name,
          lightning_address: !current.lightning_address && typeof metadata.lud16 === "string" ? metadata.lud16 : current.lightning_address,
        };
      });
      if (publicName) syncSavedGameName(pubkey, publicName);
    }).catch(() => {
      // Browser-saved profile remains usable when public relays are unavailable.
    });
  }

  function syncSavedGameName(pubkey: string, name: string) {
    let changed = false;
    const games = loadTrackedGames().map((game) => {
      const creator = game.creator_player?.pubkey === pubkey && game.creator_player.name !== name
        ? { ...game.creator_player, name } : game.creator_player;
      const counterparty = game.counterparty_player?.pubkey === pubkey && game.counterparty_player.name !== name
        ? { ...game.counterparty_player, name } : game.counterparty_player;
      if (creator === game.creator_player && counterparty === game.counterparty_player) return game;
      changed = true;
      return { ...game, creator_player: creator, counterparty_player: counterparty };
    });
    if (changed) {
      window.localStorage.setItem(GAMES_STORAGE, JSON.stringify(games));
      setTrackedGames(games);
    }
  }

  async function saveProfileToNostr() {
    if (!playerIdentity || !playerProfile) return;
    setProfilePublishBusy(true);
    setProfilePublishNotice("");
    try {
      const result = await publishPlayerProfile(playerIdentity, playerProfile);
      syncSavedGameName(playerIdentity.pubkey, playerProfile.name.trim());
      setProfilePublishNotice(`Published to ${result.published.length} Nostr relay${result.published.length === 1 ? "" : "s"}.`);
      setProfileEditing(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setProfilePublishBusy(false);
    }
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
    setGameRecord(null);
    setRecordNotice("");
    setShowInviteFallback(false);
    setError("");
  }

  async function restoreTrackedGame(game: TrackedDiceGame, isCurrent: () => boolean) {
    try {
      const refreshedService = await discoverService(game.service.source);
      if (!isCurrent()) return;
      validatedServiceRef.current = refreshedService;
      validatedSourceRef.current = serializeSource(refreshedService.source);
      applyTrackedGame({ ...game, service: refreshedService });
    } catch (nextError) {
      // Keep the saved game visible even if its descriptor is temporarily unavailable.
      if (isCurrent()) setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  function applyTrackedGame(game: TrackedDiceGame) {
    setService(game.service);
    setServiceSelected(true);
    setActiveGameId(game.id);
    setAmountSats(String(game.amount_sats));
    setGameMode(game.game_mode || GameMode.HigherRollWins);
    setTargetValue(String(game.target ?? 6));
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
    setGameRecord(null);
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
      game_mode: current?.game_mode || gameMode,
      ...(current?.target !== undefined || gameMode === GameMode.RollToTarget ? { target: current?.target ?? Number(targetValue) } : {}),
      ...(current?.preferred_partner_pubkey ? { preferred_partner_pubkey: current.preferred_partner_pubkey } : {}),
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
    const nextGames = [game, ...loadTrackedGames().filter((entry) => entry.id !== game.id)]
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
    window.localStorage.setItem(GAMES_STORAGE, JSON.stringify(nextGames));
    setTrackedGames(nextGames);
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

  async function runOperation(operation: () => Promise<void>): Promise<void> {
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
    const sourceKey = serializeSource(targetService.source);
    const validatedService =
      validatedServiceRef.current && validatedSourceRef.current === sourceKey
        ? validatedServiceRef.current
        : await discoverService(targetService.source);
    if (!validatedServiceRef.current || validatedSourceRef.current !== sourceKey) {
      validatedServiceRef.current = validatedService;
      validatedSourceRef.current = sourceKey;
    }
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
          `Escrow service error (HTTP ${response.status}) during ${operation}. ` +
            (body?.error ? `${body.error} ` : "") +
            "The escrow operator may be restarting (Render free tier cold start). " +
            "Wait a few seconds, then try again.",
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

  async function loadEscrowCatalog() {
    setCatalogBusy(true);
    try {
      const response = await fetch("/api/escrows", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "Escrow catalog discovery failed.");
      const relayEntries = body.escrows as EscrowCatalogEntry[];
      setCatalog((current) => {
        const unique = [...relayEntries, ...current];
        return unique.filter((entry, index) =>
          unique.findIndex((candidate) =>
            (candidate.service?.endpoint || `${candidate.publisher_pubkey}:${candidate.identifier}`) ===
            (entry.service?.endpoint || `${entry.publisher_pubkey}:${entry.identifier}`),
          ) === index,
        );
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCatalogBusy(false);
    }
  }

  function selectService(nextService: EscrowService) {
    if (nextService.source.type !== "nostr") {
      setError("Select this escrow through its signed PIP-01 descriptor.");
      return;
    }
    startNewGame();
    setService(nextService);
    setServiceSelected(true);
    window.localStorage.setItem(SELECTED_SERVICE_STORAGE, JSON.stringify(nextService));
    if (page === "escrows") router.push("/");
  }

  return (
    <Box component="main" sx={{ minHeight: "100vh", py: { xs: 2, md: 4 } }}>
      <Container maxWidth={page === "home" ? "lg" : "md"}>
        <Stack spacing={2.5}>
          <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: { xs: 2, md: 3 } }}>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2.5} sx={{ alignItems: { md: "center" }, justifyContent: "space-between" }}>
              <Box>
                <Chip component={Link} href="/" clickable icon={<CasinoIcon />} label="Rollpot" color="primary" sx={{ mb: 1.5 }} />
                <Typography component="h1" variant={page === "home" ? "h2" : "h3"} sx={{ fontWeight: 900, letterSpacing: 0 }}>
                  {page === "home" ? "Rollpot" : page === "escrows" ? "Escrows" : page === "games" ? "Games" : escrow
                    ? `${creatorPlayer?.name || "Player 1"} vs ${counterpartyPlayer?.name || "Player 2"}`
                    : "Game"}
                </Typography>
                <Typography color="text.secondary">
                  {page === "home"
                    ? "Invite a Nostr player, fund the pot, then each roll a die."
                    : page === "escrows"
                      ? "Choose the escrow service for your next game."
                      : page === "games"
                        ? "Your saved games, newest first."
                      : escrow ? `${escrow.amount_sats * 2} sats pot · ${gameHeaderStatus}` : "Your saved game"}
                </Typography>
              </Box>
              {page === "game" ? (
                <Stack spacing={1.5} sx={{ alignItems: { md: "flex-end" } }}>
                  {escrow ? <Chip label={gameModeLabel(selectedMode, selectedTarget)} color="primary" variant="outlined" sx={{ alignSelf: { xs: "flex-start", md: "flex-end" } }} /> : null}
                  {displayedRolls ? <Stack direction="row" spacing={2}>
                    <DiceFace label={creatorPlayer?.name || "Player 1"} value={displayedRolls.creator_roll} />
                    <DiceFace label={counterpartyPlayer?.name || "Player 2"} value={displayedRolls.counterparty_roll} />
                  </Stack> : null}
                </Stack>
              ) : page === "home" || page === "escrows" ? (
                <Stack direction="row" spacing={1}>
                  {page === "home" ? <Button component={Link} href="/escrows" variant="outlined">Escrows</Button> : null}
                  {page === "escrows" ? <Button variant="outlined" onClick={() => void loadEscrowCatalog()} disabled={catalogBusy}>{catalogBusy ? "Refreshing…" : "Refresh"}</Button> : null}
                </Stack>
              ) : null}
            </Stack>
          </Paper>

          {busy ? <LinearProgress /> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          {page === "home" && serviceSelected && !appSignerTrusted ? (
            <Alert severity="error">
              Rollpot's server signing key is not configured. Set ROLLPOT_SERVER_NSEC before creating or joining a funded game.
            </Alert>
          ) : null}
          {page === "home" && serviceSelected && appSignerTrusted && service?.source.type !== "nostr" ? (
            <Alert severity="warning">Select an escrow discovered from a signed PIP-01 descriptor before creating or joining a PIP-02 game.</Alert>
          ) : null}
          {page === "home" && !serviceSelected ? <Alert severity="info">Select an escrow before creating a game.</Alert> : null}
          {rematchInvites.map((invite) => <Card key={invite.eventId} variant="outlined" sx={{ borderColor: "warning.main", bgcolor: "rgba(240, 140, 0, 0.08)" }}>
            <CardContent sx={{ "&:last-child": { pb: 2 } }}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
                <Box>
                  <Typography variant="subtitle1" color="warning.light" sx={{ fontWeight: 900 }}>Rematch request</Typography>
                  <Typography variant="body2">{invite.senderName} invited you to play again.</Typography>
                </Box>
                <Button color="warning" variant="contained" size="small" disabled={!canAuthenticate || !appSignerTrusted || !profileConfigured || busy} onClick={() => void joinInvite(invite.code)}>Join rematch</Button>
              </Stack>
            </CardContent>
          </Card>)}

          {page === "escrows" ? <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 2 }}>
            <Stack spacing={2}>
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>Compatible Escrows</Typography>
                  <Typography variant="body2" color="text.secondary">Signed PIP-01 services available for new Rollpot games.</Typography>
                </Box>
                <Stack spacing={1}>
                    {playableEscrows.map((entry) => {
                    const candidate = entry.service;
                    const signerTrusted = candidate ? isApplicationSignerTrusted(candidate, appSigner?.pubkey) : false;
                    const selectable = entry.compatible && Boolean(candidate) && signerTrusted;
                    const selected = Boolean(candidate && serviceSelected && service && candidate.service_id === service.service_id);
                    const descriptor = entry.descriptor || candidate?.descriptor;
                    const coordinate = entry.source.type === "nostr" ? `30361:${entry.source.event.pubkey}:${entry.identifier}` : "";

                      return (
                        <Paper key={serializeSource(entry.source)} variant="outlined" sx={{ p: 1.5 }}>
                        <Stack spacing={1.25}>
                          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
                          <Box sx={{ minWidth: 0 }}>
                            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                              <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>{entry.identifier}</Typography>
                              {selected ? <Chip size="small" label="selected" color="primary" /> : null}
                            </Stack>
                            <Typography variant="body2" color="text.secondary">
                              {descriptor?.networks?.map((network) => network.charAt(0).toUpperCase() + network.slice(1)).join(", ") || "Network not declared"}
                              {candidate?.funding_models?.includes("2_of_2") ? " · 2 of 2 funding" : ""}
                            </Typography>
                          </Box>
                          <Stack direction="row" spacing={1}>
                            <Button size="small" variant="text" startIcon={<InfoOutlinedIcon />} onClick={() => setDetailEntry(entry)}>Details</Button>
                            {!selected ? <Button size="small" disabled={!selectable} variant="contained" onClick={() => candidate && selectService(candidate)}>Select</Button> : null}
                          </Stack>
                          </Stack>
                          {coordinate ? <Stack direction="row" spacing={1} sx={{ alignItems: "center", bgcolor: "background.default", borderRadius: 1, px: 1.25, py: 0.75 }}>
                            <Typography variant="caption" sx={{ flex: 1, minWidth: 0, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{coordinate}</Typography>
                            <Tooltip title="Copy escrow coordinate"><Button size="small" variant="text" aria-label={`Copy ${entry.identifier} coordinate`} onClick={() => navigator.clipboard.writeText(coordinate)} sx={{ minWidth: 34, px: 0.5 }}><ContentCopyIcon fontSize="small" /></Button></Tooltip>
                          </Stack> : null}
                        </Stack>
                        </Paper>
                      );
                    })}
                    {!catalogBusy && playableEscrows.length === 0 ? <Alert severity="info">No compatible signed escrow services were found.</Alert> : null}
                </Stack>
                {incompatibleEscrowCount > 0 ? <Paper variant="outlined" sx={{ overflow: "hidden" }}>
                  <Button
                    fullWidth
                    variant="text"
                    aria-expanded={showIncompatibleEscrows}
                    onClick={() => setShowIncompatibleEscrows((shown) => !shown)}
                    sx={{ color: "text.primary", justifyContent: "space-between", px: 1.5, py: 1.25, textAlign: "left" }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 900, textTransform: "none" }}>
                        {showIncompatibleEscrows ? "Hide" : "Show"} Incompatible Escrows
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", textTransform: "none" }}>
                        Signed descriptors that cannot run a Rollpot game.
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", flexShrink: 0, ml: 2 }}>
                      <Chip size="small" label={incompatibleEscrowCount} aria-label={`${incompatibleEscrowCount} incompatible escrows`} />
                      {showIncompatibleEscrows ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                    </Stack>
                  </Button>
                  {showIncompatibleEscrows ? <Stack spacing={1} sx={{ borderTop: "1px solid", borderColor: "divider", p: 1.25 }}>
                    {incompatibleEscrows.map((entry) => {
                      const descriptor = entry.descriptor || entry.service?.descriptor;
                      const coordinate = entry.source.type === "nostr" ? `30361:${entry.source.event.pubkey}:${entry.identifier}` : "";
                      return <Paper key={`omitted:${serializeSource(entry.source)}`} variant="outlined" sx={{ p: 1.25, bgcolor: "background.default" }}>
                        <Stack spacing={1}>
                          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "flex-start" }, justifyContent: "space-between" }}>
                            <Box sx={{ minWidth: 0 }}>
                              <Typography variant="subtitle2" sx={{ fontWeight: 800, overflowWrap: "anywhere" }}>{entry.identifier}</Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>{descriptor?.networks?.join(", ") || "Network not declared"}</Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>{entry.compatibility_reason || "Not compatible with Rollpot."}</Typography>
                            </Box>
                            <Button size="small" variant="text" startIcon={<InfoOutlinedIcon />} onClick={() => setDetailEntry(entry)}>Details</Button>
                          </Stack>
                          {coordinate ? <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                            <Typography variant="caption" sx={{ flex: 1, minWidth: 0, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{coordinate}</Typography>
                            <Tooltip title="Copy escrow coordinate"><Button size="small" variant="text" aria-label={`Copy ${entry.identifier} coordinate`} onClick={() => navigator.clipboard.writeText(coordinate)} sx={{ minWidth: 34, px: 0.5 }}><ContentCopyIcon fontSize="small" /></Button></Tooltip>
                          </Stack> : null}
                        </Stack>
                      </Paper>;
                    })}
                  </Stack> : null}
                </Paper> : null}
              </Stack>
          </Paper> : null}

          {page !== "escrows" ? <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={page === "home" ? 0 : 2.5}
            sx={page === "home" ? {
              display: "grid",
              gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" },
              gap: 2.5,
              alignItems: "stretch",
            } : { alignItems: "flex-start" }}
          >
            {page === "home" ? <Stack spacing={0} sx={{ display: "contents" }}>
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
                    ) : null}
                    {playerIdentity && profileConfigured && !profileEditing ? (
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{playerProfile?.name}</Typography>
                          <Typography variant="body2" color="text.secondary" noWrap>{playerProfile?.lightning_address}</Typography>
                        </Box>
                        <Button size="small" variant="outlined" onClick={() => setProfileEditing(true)}>Edit</Button>
                      </Stack>
                    ) : null}
                    {playerIdentity && (!profileConfigured || profileEditing) ? (
                      <>
                        <Stack direction="row" spacing={1}>
                          <Button type="button" disabled={authBusy} variant="outlined" onClick={loginWithNostr} startIcon={<LoginIcon />}>
                            Switch Nostr
                          </Button>
                          <Button type="button" variant="outlined" onClick={signupLocalPlayer} startIcon={<PersonAddIcon />}>
                            New local
                          </Button>
                        </Stack>
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
                        {profileConfigured ? <Button size="small" onClick={() => setProfileEditing(false)} sx={{ alignSelf: "flex-end" }}>Done</Button> : null}
                      </>
                    ) : null}
                    {profileConfigured ? <Button disabled={profilePublishBusy} size="small" variant="outlined" onClick={saveProfileToNostr} sx={{ alignSelf: "flex-start" }}>
                      {profilePublishBusy ? "Publishing…" : "Save to Nostr"}
                    </Button> : null}
                    {profilePublishNotice ? <Alert severity="success">{profilePublishNotice}</Alert> : null}
                  </Stack>
                </CardContent>
              </Card>

                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={2}>
                      <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                        <Typography variant="h6" sx={{ fontWeight: 900 }}>
                          Play
                        </Typography>
                      </Stack>
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                        <Typography variant="body2" color="text.secondary">
                          Escrow: {serviceSelected && service ? serviceLabel(service) : "none selected"}
                        </Typography>
                        <Button component={Link} href="/escrows" size="small" variant="text">
                          Change escrow
                        </Button>
                      </Stack>
                      {!profileConfigured ? <Alert severity="info">Complete your player profile to create or join a game.</Alert> : null}
                      {profileConfigured ? <>
                      <ToggleButtonGroup
                        exclusive
                        fullWidth
                        size="small"
                        value={playMode}
                        onChange={(_, nextMode: "create" | "join" | null) => { if (nextMode) setPlayMode(nextMode); }}
                        aria-label="Choose how to play"
                      >
                        <ToggleButton value="create">Create</ToggleButton>
                        <ToggleButton value="join">Join</ToggleButton>
                      </ToggleButtonGroup>
                      {playMode === "create" ? <>
                      <TextField label="Amount per player, sats" value={amountSats} onChange={(event) => setAmountSats(event.target.value)} size="small" type="number" />
                      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Game mode</Typography>
                      <ToggleButtonGroup exclusive size="small" value={gameMode} onChange={(_, value: GameMode | null) => { if (value) setGameMode(value); }} sx={{ flexWrap: "wrap" }}>
                        <ToggleButton value={GameMode.HigherRollWins}>Higher roll</ToggleButton>
                        <ToggleButton value={GameMode.LowerRollWins}>Lower roll</ToggleButton>
                        <ToggleButton value={GameMode.RollToTarget}>Roll to target</ToggleButton>
                      </ToggleButtonGroup>
                      {gameMode === GameMode.RollToTarget ? <TextField label="Target die face (1–6)" value={targetValue} onChange={(event) => setTargetValue(event.target.value)} size="small" type="number" error={!/^[1-6]$/.test(targetValue)} helperText="Exactly one player must hit this number. Otherwise, both roll again." /> : null}
                      <Typography variant="body2" color="text.secondary">{gameModeDescription(gameMode, gameMode === GameMode.RollToTarget ? Number(targetValue) : undefined)}</Typography>
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
                        disabled={!canCallService || gameMode === GameMode.RollToTarget && !/^[1-6]$/.test(targetValue) || (requiresCounterpartyPubkey && (!normalizedCounterpartyPubkey || Boolean(counterpartyPubkeyError))) || busy}
                        variant="contained"
                        onClick={createEscrow}
                        startIcon={<LocalAtmIcon />}
                      >
                        Create game
                      </Button>
                      </> : <>
                      {invitePreview && inviteInput.trim() ? <Stack spacing={0.5}>
                        <InviteCodePreview code={inviteInput.trim()} />
                        <Button size="small" variant="text" onClick={() => { setInviteInput(""); setInvitePreview(false); }} sx={{ alignSelf: "flex-start" }}>Replace invite</Button>
                      </Stack> : <TextField
                        label="Paste invite code"
                        value={inviteInput}
                        onChange={(event) => {
                          const nextCode = event.target.value;
                          setInviteInput(nextCode);
                          if (nextCode.trim().length > 80) setInvitePreview(true);
                        }}
                        onPaste={(event) => {
                          const pasted = event.clipboardData.getData("text").trim();
                          if (!pasted) return;
                          event.preventDefault();
                          setInviteInput(pasted);
                          setInvitePreview(true);
                        }}
                        size="small"
                        fullWidth
                      />}
                      <Button disabled={!canAuthenticate || !appSignerTrusted || !inviteInput.trim() || busy} variant="outlined" onClick={() => void joinInvite()} startIcon={<LoginIcon />}>
                        Join game
                      </Button>
                      </>}
                      </> : null}
                    </Stack>
                  </CardContent>
                </Card>
            </Stack> : null}

            <Stack spacing={page === "home" ? 0 : 2.5} sx={page === "home" ? { display: "contents" } : { flex: 1, minWidth: 0, width: "100%" }}>
              {page === "home" || page === "games" ? <>
              <Card variant="outlined" sx={page === "home" ? { gridColumn: "1 / -1" } : undefined}>
                <CardContent>
                  <Stack spacing={1.5}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      <HistoryIcon color="primary" fontSize="small" />
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>{page === "home" ? "Recent Games" : "All games"}</Typography>
                    </Stack>
                    {trackedGames.length === 0 ? (
                      <Typography color="text.secondary">Games you create or join appear here.</Typography>
                    ) : trackedGames.slice(0, page === "home" ? 3 : undefined).map((game) => (
                      <Stack key={game.id} direction="row" spacing={1} sx={{ alignItems: "stretch" }}>
                        <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.25, flex: 1, minWidth: 0 }}>
                          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
                            <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                            <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>
                              {game.release
                                ? `Winner: ${winnerLabel(game.release.recipient, game)}`
                                : `${game.creator_player?.name || "Player 1"}${game.counterparty_player ? ` vs ${game.counterparty_player.name}` : "'s game"}`}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {game.amount_sats} sats each · {game.release ? "Settled" : gameStatusLabel(game)} · {formatGameTime(game.updated_at)}
                            </Typography>
                            </Stack>
                            <Button component={Link} href={gamePath(game)} size="small" variant="outlined" sx={{ flexShrink: 0, alignSelf: { xs: "flex-start", sm: "center" } }}>
                              View Game
                            </Button>
                          </Stack>
                        </Box>
                        {isGameExpired(game) ? (
                          <Tooltip title="Delete expired game">
                            <Button size="small" variant="outlined" color="error" onClick={() => deleteTrackedGame(game.id)} sx={{ minWidth: 36, px: 1 }}>
                              <DeleteIcon fontSize="small" />
                            </Button>
                          </Tooltip>
                        ) : null}
                      </Stack>
                    ))}
                    {page === "home" ? <Button component={Link} href="/games" size="small" variant="contained" sx={{ alignSelf: "flex-start" }}>
                      View All Games
                    </Button> : null}
                  </Stack>
                </CardContent>
              </Card>
              </> : !hydrated ? <LinearProgress /> : gameMissing ? (
                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={1.5}>
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>Game not found</Typography>
                      <Typography color="text.secondary">This game is not saved in this browser.</Typography>
                      <Button component={Link} href="/games" variant="outlined" sx={{ alignSelf: "flex-start" }}>View saved games</Button>
                    </Stack>
                  </CardContent>
                </Card>
              ) : (
                <Card variant="outlined">
                  <CardContent>
                    <Stack spacing={2}>
                      <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
                        <Stack spacing={1} sx={{ minWidth: 0 }}>
                          <Typography variant="h6" sx={{ fontWeight: 900 }}>
                            {gameEnded ? "Game over" : !playerJoined ? `Invite ${rematchPartnerName}` : sharedWinner ? "Winner decided" : readyToRoll ? "Your turn to roll" : paymentsReady && ownRoll ? "Waiting for the other roll" : paymentsReady && currentGame?.secured ? "Rolls" : paymentsReady && currentGame?.accepted.size === 2 ? "Securing the pot" : paymentsReady ? "Confirming payments" : "Fund the pot"}
                          </Typography>
                          {escrow && playerJoined && gameRecord ? <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8125rem" }}>{gameModeDescription(selectedMode, selectedTarget)}</Typography> : null}
                          {gameStatusLine ? <Stack direction="row" spacing={0.75} role="status" aria-live="polite" sx={{ alignItems: "flex-start" }}>
                            <InfoOutlinedIcon sx={{ fontSize: 18, mt: "2px", color: sharedWinner ? "success.main" : "primary.main" }} />
                            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: sharedWinner ? "success.main" : "text.primary" }}>{gameStatusLine}</Typography>
                          </Stack> : null}
                        </Stack>
                        {paymentsReady && !sharedWinner && !gameEnded && selectedMode === GameMode.RollToTarget && selectedTarget ? (
                          <Box sx={{ flexShrink: 0 }}><DiceFace label={`Target ${selectedTarget}`} value={selectedTarget} size={72} /></Box>
                        ) : null}
                      </Stack>

                      {escrow ? (
                        <Stack spacing={1.5}>
                        {authLoaded && !gameIdentityMatches ? (
                          <Alert severity="warning">
                            Sign in on the home page with the Nostr identity used for this game before requesting payment or rolling.
                          </Alert>
                        ) : null}
                          {inviteCode && !playerJoined && trackedGames.find((game) => game.id === activeGameId)?.invite_delivery === "nostr" && !showInviteFallback ? (
                            <Stack spacing={0.5} sx={{ alignItems: "flex-start" }}>
                              <Typography variant="body2">Encrypted rematch invite sent to {rematchPartnerName} on Nostr.</Typography>
                              <Button size="small" onClick={() => setShowInviteFallback(true)}>Show invite code</Button>
                            </Stack>
                          ) : inviteCode && !playerJoined ? <InviteCode code={inviteCode} /> : null}

                          {recordNotice ? <Alert severity="warning">{recordNotice}</Alert> : null}
                          {!sharedWinner && (currentPair?.creator || currentPair?.counterparty) ? <Paper variant="outlined" sx={{ alignSelf: "flex-start", p: 1.25, borderColor: "primary.main", bgcolor: "background.default" }}>
                            <Stack spacing={1}>
                              <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>Round {currentGame?.currentRound} · In progress</Typography>
                              <Stack direction="row" spacing={1.5}>
                                <DiceFace label={creatorPlayer?.name || "Player 1"} value={currentPair.creator?.value ?? null} size={88} />
                                <DiceFace label={counterpartyPlayer?.name || "Player 2"} value={currentPair.counterparty?.value ?? null} size={88} />
                              </Stack>
                            </Stack>
                          </Paper> : null}
                          {previousRounds.length ? <Stack spacing={1} sx={{ pt: 0.5 }}>
                            <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>Previous rounds</Typography>
                            <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1.5 }}>
                              {previousRounds.map(([round, pair]) => <Paper key={round} variant="outlined" sx={{ p: 1.25, bgcolor: "background.default" }}>
                                <Stack spacing={1}>
                                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>Round {round} · No winner</Typography>
                                  <Stack direction="row" spacing={1.5}>
                                    <DiceFace label={creatorPlayer?.name || "Player 1"} value={pair.creator!.value} size={76} />
                                    <DiceFace label={counterpartyPlayer?.name || "Player 2"} value={pair.counterparty!.value} size={76} />
                                  </Stack>
                                </Stack>
                              </Paper>)}
                            </Stack>
                          </Stack> : null}
                          {showFundingCard ? (
                          <FundingStatusCard
                            title={`Pay ${escrow.amount_sats} sats as ${currentGamePlayer?.name || "you"}`}
                            disabled={!canRequestPayment || busy}
                            instructions={myFunding}
                            status={myStatus}
                            onInstructions={loadMyFunding}
                            onStatus={refreshMyStatus}
                          />
                          ) : null}

                          {canRoll ? <Button disabled={busy} variant="contained" color="secondary" onClick={rollMyDie} startIcon={<CasinoIcon />}>
                            {currentGame && currentGame.currentRound > 1 ? "Roll again" : "Roll my die"}
                          </Button> : null}
                          {currentGame?.result && !gameEnded ? <Typography variant="subtitle2" role="status" aria-live="polite" color="text.secondary">
                            Rollpot is sending the pot to {currentGame.result.winner === "creator" ? creatorPlayer?.name || "Player 1" : counterpartyPlayer?.name || "Player 2"}…
                          </Typography> : null}
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
              {page === "game" && escrow && !gameMissing ? <Card variant="outlined">
                <CardContent>
                  <Stack spacing={1.5}>
                    <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" }, justifyContent: "space-between" }}>
                      <Box>
                        <Typography variant="h6" sx={{ fontWeight: 900 }}>Escrow state</Typography>
                        <Typography variant="body2" color="text.secondary">{escrowStateSummary}</Typography>
                      </Box>
                      <Button size="small" variant="outlined" aria-expanded={escrowDetailsOpen} onClick={() => setEscrowDetailsOpen((open) => !open)}>
                        {escrowDetailsOpen ? "Hide Details" : "View Details"}
                      </Button>
                    </Stack>
                    {escrowDetailsOpen ? <Stack spacing={1.5} sx={{ pt: 0.5 }}>
                      <KeyValue label="Escrow ID" value={escrow.escrow_id} copy />
                      <KeyValue label="Service state" value={releaseResponse?.state || technicalStatus?.state || escrow.state} />
                      <KeyValue label="Funding model" value={escrow.funding_model} />
                      <KeyValue label="Funding threshold" value={`${fundingThreshold} of ${escrow.participant_count ?? 2}`} />
                      <KeyValue label="Reported funded count" value={fundedCount == null ? "Not provided by service" : String(fundedCount)} />
                      <KeyValue label="Threshold reached" value={paymentsReady ? "Yes (service state active)" : allPaid ? "Yes (escrow released)" : "Not yet confirmed"} />
                      {gameRecord ? <KeyValue label="PIP-02 coordination" value={gameRecord.settlement ? "Settled" : gameRecord.refund ? "Refunded" : gameRecord.result ? `Round ${gameRecord.result.round}: result recorded` : gameRecord.secured ? `Pot secured · round ${gameRecord.currentRound}` : `${gameRecord.accepted.size} of 2 players accepted`} /> : null}
                      {technicalStatus?.total_funders != null ? <KeyValue label="Registered funders" value={String(technicalStatus.total_funders)} /> : null}
                      {!allPaid && !gameEnded && (escrow.funding_deadline || inviteFundingDeadline) ? <KeyValue
                        label={escrow.funding_deadline ? "Funding deadline (service)" : "Funding deadline (creator invite)"}
                        value={escrow.funding_deadline || inviteFundingDeadline || ""}
                      /> : null}
                      {releaseResponse ? <KeyValue label="Release" value={`${releaseResponse.payout_sats} sats to ${releaseResponse.recipient}`} /> : null}
                      {service ? <KeyValue label="Escrow service" value={serviceLabel(service)} /> : null}
                      <Button disabled={!gameIdentityMatches || busy} size="small" variant="text" onClick={refreshMyStatus} sx={{ alignSelf: "flex-start" }}>
                        Refresh state
                      </Button>
                      {canCancelEscrow ? <Button disabled={busy} size="small" variant="text" color="warning" onClick={cancelUnfinishedGame} sx={{ alignSelf: "flex-start" }}>Cancel unfinished game</Button> : null}
                      {canRequestRefund ? <Button disabled={busy} size="small" variant="text" color="warning" onClick={requestGameRefund} sx={{ alignSelf: "flex-start" }}>Request refund recovery</Button> : null}
                    </Stack> : null}
                  </Stack>
                </CardContent>
              </Card> : null}
              {page === "game" && escrow && !gameMissing ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignSelf: "flex-start", alignItems: "flex-start" }}>
                {rematchPartnerPubkey && (sharedWinner || gameEnded) ? <Button disabled={busy || !gameIdentityMatches || !profileConfigured || !service || !canAuthenticate || !appSignerTrusted} variant="contained" onClick={playAgain} startIcon={<CasinoIcon />}>Play again with {rematchPartnerName}</Button> : null}
                <Button component={Link} href="/games" variant="outlined" startIcon={<ArrowBackIcon />}>All games</Button>
              </Stack> : null}
            </Stack>
          </Stack> : null}
        </Stack>
      </Container>

      {page === "escrows" ? <EscrowDetailDialog entry={detailEntry} onClose={() => setDetailEntry(null)} appSigner={appSigner} onSelect={selectService} canSelect={(entry) => entry.source.type === "nostr" && entry.compatible && Boolean(entry.service) && isApplicationSignerTrusted(entry.service!, appSigner?.pubkey)} /> : null}
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
  const selectable = canSelect(entry);
  const coordinate = entry.source.type === "nostr" ? `30361:${entry.source.event.pubkey}:${entry.identifier}` : "";

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
          {coordinate ? <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Box sx={{ flex: 1, minWidth: 0 }}><DetailRow label="Coordinate" value={coordinate} mono /></Box>
            <Button size="small" variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => navigator.clipboard.writeText(coordinate)}>Copy</Button>
          </Stack> : null}

          {descriptor ? (
            <>
              <DetailRow label="Version" value={String(descriptor.version)} />
              <DetailRow label="Escrow type" value={descriptor.escrow_type || "—"} />
              <DetailRow label="Networks" value={descriptor.networks?.join(", ") || "—"} />
              <DetailRow label="Reference format" value={descriptor.reference_format || "—"} />
              <DetailRow label="Updated at" value={descriptor.updated_at ? new Date(descriptor.updated_at * 1000).toLocaleString() : "—"} />
              <DetailRow label="Funding threshold" value={descriptor.funding_rules?.funding_threshold != null ? String(descriptor.funding_rules.funding_threshold) : "—"} />
              <DetailRow label="Participants" value={descriptor.funding_rules?.participant_count != null ? String(descriptor.funding_rules.participant_count) : "—"} />
              <DetailRow label="Funding confirmation" value={descriptor.funding_rules?.required_confirmation || "—"} />
              <DetailRow label="Funding timeout" value={descriptor.funding_rules?.funding_timeout || "—"} />
              <DetailRow label="Dispute policy" value={descriptor.dispute_rules?.policy || "—"} />
            </>
          ) : null}

          {candidate ? (
            <>
              <Typography variant="subtitle2" sx={{ fontWeight: 900, mt: 1 }}>Service</Typography>
              <DetailRow label="Endpoint" value={candidate.endpoint || "—"} mono />
              <DetailRow label="Schema URL" value={candidate.schema_url || "—"} mono />
              <DetailRow label="Funding models" value={candidate.funding_models?.join(", ") || "—"} />
              <DetailRow label="Release decisions" value={candidate.release_decisions?.join(", ") || "—"} />
              <DetailRow label="Enrollment" value={candidate.enrollment || "—"} />
            </>
          ) : null}

          {service?.schema?.url ? <DetailRow label="Descriptor schema" value={service.schema.url} mono /> : null}

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
  mode,
  target,
  preferredPartnerPubkey,
}: {
  escrow: CreateEscrowResponse;
  service: EscrowService;
  role: "creator" | "counterparty";
  creator: PlayerProfile;
  counterparty: PlayerProfile | null;
  mode: GameMode;
  target?: number;
  preferredPartnerPubkey?: string;
}): TrackedDiceGame {
  const now = new Date().toISOString();

  return {
    id: getGameId(service.service_id, escrow.escrow_id),
    created_at: now,
    updated_at: now,
    amount_sats: escrow.amount_sats,
    game_mode: mode,
    ...(target !== undefined ? { target } : {}),
    ...(preferredPartnerPubkey ? { preferred_partner_pubkey: preferredPartnerPubkey } : {}),
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
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>Invite Player 2</Typography>
        <Button size="small" variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => navigator.clipboard.writeText(code)}>
          Copy invite
        </Button>
      </Stack>
      <InviteCodePreview code={code} />
    </Stack>
  );
}

function InviteCodePreview({ code }: { code: string }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [visibleAtEachEnd, setVisibleAtEachEnd] = useState(14);

  useEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const update = () => {
      const style = window.getComputedStyle(text);
      const measure = document.createElement("canvas").getContext("2d");
      if (!measure) return;
      measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const characterWidth = measure.measureText("M").width;
      if (!characterWidth) return;
      const ellipsisWidth = measure.measureText("…").width;
      const count = Math.max(4, Math.floor((text.clientWidth - ellipsisWidth - characterWidth * 2) / (characterWidth * 2)));
      setVisibleAtEachEnd(count);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(text);
    return () => observer.disconnect();
  }, []);

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, px: 1.5, py: 0.75, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Invite code</Typography>
      <Typography ref={textRef} variant="body2" sx={{ fontFamily: "monospace", fontVariantLigatures: "none", whiteSpace: "nowrap", overflow: "hidden" }}>
        {middleTruncate(code, visibleAtEachEnd)}
      </Typography>
    </Box>
  );
}

function middleTruncate(value: string, visibleAtEachEnd: number): string {
  if (value.length <= visibleAtEachEnd * 2 + 1) return value;
  return `${value.slice(0, visibleAtEachEnd)}…${value.slice(-visibleAtEachEnd)}`;
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

type GameExpectation = { escrow_id: string; service_id: string; amount_sats: number; player1: string; player2: string; game_mode?: GameMode; target?: number; escrow_authority?: string; descriptor_event_id?: string; descriptor_address?: string };

async function loadPublishedGame(expected: GameExpectation, rootId?: string, ready?: (record: GameRecord) => boolean, allowLocalFallback = false, localRecord?: GameRecord): Promise<GameRecord | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let events: Event[];
    try { events = await loadGameEvents(expected.escrow_id, rootId); }
    catch (error) {
      if (attempt === 2) { if (allowLocalFallback) return null; throw error; }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    const record = replayGameRecord(localRecord ? [localRecord.root, ...localRecord.actions, ...events] : events, expected);
    if (localRecord && record?.root.id !== localRecord.root.id) throw new Error("The shared game root has changed.");
    if (record && (!ready || ready(record)) || attempt === 2) return record;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return null;
}

async function loadGameEvents(escrowId: string, rootId?: string): Promise<Event[]> {
  const response = await fetch(`/api/nostr/game?escrow_id=${encodeURIComponent(escrowId)}${rootId ? `&root_id=${encodeURIComponent(rootId)}` : ""}`, { cache: "no-store" });
  const body = await response.json() as { events?: Event[]; error?: string };
  if (!response.ok || !Array.isArray(body.events)) throw new Error(body.error || "Could not read the shared game record.");
  return body.events;
}

async function publishPlayerGameEvent(identity: EscrowIdentity, template: EventTemplate, journalEvents: Event[] = []): Promise<Event> {
  const event = await signPlayerEvent(identity, template);
  const response = await fetch("/api/nostr/game", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, journal_events: journalEvents }),
  });
  const body = await response.json() as { event_id?: string; error?: string };
  if (!response.ok || body.event_id !== event.id) throw new Error(body.error || "Could not publish the shared game record.");
  return event;
}

type ServerGameResultOutcome = {
  event_id: string;
  authority_event?: Event;
  escrow_state?: string;
  result?: DiceGameResult;
  release?: ReleaseEscrowResponse | null;
  settlement_error?: string;
};

async function publishServerGameAuthority(identity: EscrowIdentity, service: EscrowService, operation: "secure" | "settle" | "refund", journalEvents: Event[], playerNames?: { creator?: string; counterparty?: string }): Promise<ServerGameResultOutcome> {
  const fundStatusAuthorization = await buildNip98Authorization(identity, "POST", service.operation_urls.fund_status);
  const economicAuthorization = operation === "secure" ? undefined : await buildNip98Authorization(identity, "POST", operation === "settle" ? service.operation_urls.release : service.operation_urls.refund);
  const response = await fetch("/api/nostr/game/result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation,
      journal_events: journalEvents,
      service_source: service.source,
      ...(playerNames ? { player_names: playerNames } : {}),
      fund_status_authorization: fundStatusAuthorization,
      ...(economicAuthorization ? { economic_authorization: economicAuthorization } : {}),
    }),
  });
  const outcome = await response.json() as ServerGameResultOutcome & { error?: string };
  if (!response.ok) throw new Error(outcome.error || "Rollpot could not advance the economic coordination.");
  return outcome;
}

function coordinationBinding(service: EscrowService, authority: string) {
  const descriptorD = service.source.type === "nostr" ? service.source.event.tags.find((tag) => tag[0] === "d")?.[1] || "" : "";
  return { escrow_authority: authority, descriptor_event_id: service.source.type === "nostr" ? service.source.event.id : "", descriptor_address: service.source.type === "nostr" && descriptorD ? `30361:${service.source.event.pubkey}:${descriptorD}` : "" };
}

function expectedGame(escrow: CreateEscrowResponse, service: EscrowService, game: GameRecord, authority: string): GameExpectation {
  return { escrow_id: escrow.escrow_id, service_id: service.service_id, amount_sats: escrow.amount_sats, player1: game.root.pubkey, player2: game.terms.counterparty_pubkey, game_mode: game.mode, target: game.target, ...coordinationBinding(service, authority) };
}

function recordCreatedAt(escrowId: string, pubkey: string, action: GameRecordAction, rootId = "", minimum = 0): number {
  const key = `pontmore-rollpot-record-time:${escrowId}:${pubkey}:${action}:${rootId}`;
  try {
    const saved = Number(window.localStorage.getItem(key));
    if (Number.isSafeInteger(saved) && saved >= minimum && saved > 0) return saved;
    const createdAt = Math.max(Math.floor(Date.now() / 1000), minimum);
    window.localStorage.setItem(key, String(createdAt));
    return createdAt;
  } catch {
    return Math.max(Math.floor(Date.now() / 1000), minimum);
  }
}

function savedRollValue(escrowId: string, pubkey: string, rootId: string, round: number): number {
  const key = `pontmore-rollpot-roll:${escrowId}:${pubkey}:${rootId}:${round}`;
  try {
    const saved = Number(window.localStorage.getItem(key));
    if (Number.isInteger(saved) && saved >= 1 && saved <= 6) return saved;
    const value = rollDie();
    window.localStorage.setItem(key, String(value));
    return value;
  } catch {
    return rollDie();
  }
}

function resultRecordTime(game: GameRecord, pubkey: string): number {
  const latestAcceptance = Math.max(game.root.created_at, ...game.actions.map((action) => action.created_at));
  return recordCreatedAt(game.terms.escrow_id, pubkey, GameRecordAction.Result, game.root.id, latestAcceptance + 1);
}

function loadSelectedService(): EscrowService | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SELECTED_SERVICE_STORAGE) || "null") as EscrowService | null;
    return saved?.source && saved?.operation_urls && saved?.endpoint ? saved : null;
  } catch {
    return null;
  }
}

function gamePath(game: TrackedDiceGame) {
  return `/games/${encodeURIComponent(game.escrow.escrow_id)}`;
}

function serviceLabel(service: EscrowService) {
  return service.source.type === "nostr"
    ? service.source.event.tags.find(([name]) => name === "d")?.[1] || "Nostr escrow"
    : "Direct URL escrow";
}

function serviceCoordinate(service: EscrowService) {
  if (service.source.type !== "nostr") return "";
  const identifier = service.source.event.tags.find(([name]) => name === "d")?.[1] || "";
  return identifier ? `30361:${service.source.event.pubkey}:${identifier}` : "";
}

function isGameExpired(game: TrackedDiceGame) {
  if (game.release) return false;

  const escrowFunded =
    game.creator_status?.funded ||
    game.creator_status?.my_funded ||
    game.counterparty_status?.funded ||
    game.counterparty_status?.my_funded ||
    (game.creator_status?.funded_count ?? 0) > 0 ||
    (game.counterparty_status?.funded_count ?? 0) > 0 ||
    (game.creator_status?.funded_count ?? 0) >= (game.creator_status?.funding_threshold ?? 2) ||
    (game.counterparty_status?.funded_count ?? 0) >= (game.counterparty_status?.funding_threshold ?? 2);

  if (escrowFunded) return false;

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

function gameModeDescription(mode: GameMode, target?: number): string {
  if (mode === GameMode.LowerRollWins) return "Each player rolls one die. Lower roll wins; ties mean both roll again.";
  if (mode === GameMode.RollToTarget) return `Each player rolls one die. Exactly one hit on ${target} wins; otherwise both roll again.`;
  return "Each player rolls one die. Higher roll wins; ties mean both roll again.";
}

function gameModeLabel(mode: GameMode, target?: number): string {
  if (mode === GameMode.LowerRollWins) return "Lower roll wins";
  if (mode === GameMode.RollToTarget) return `Roll to ${target}`;
  return "Higher roll wins";
}

function decodeInvite(value: string): GameInvite {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const invite = JSON.parse(atob(padded)) as GameInvite;

  if (
    ![1, 2].includes(invite.version) ||
    invite.game !== "rollpot" ||
    (invite.version === 2 && (!Object.values(GameMode).includes(invite.game_mode as GameMode) || (invite.game_mode === GameMode.RollToTarget ? !Number.isInteger(invite.target) || Number(invite.target) < 1 || Number(invite.target) > 6 : invite.target !== undefined))) ||
    !invite.enrollment_token ||
    (invite.counterparty_pubkey != null && !/^[0-9a-f]{64}$/.test(invite.counterparty_pubkey)) ||
    (invite.funding_deadline != null && (typeof invite.funding_deadline !== "string" || Number.isNaN(Date.parse(invite.funding_deadline)))) ||
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

function serializeSource(source: EscrowService["source"]) {
  return source.type === "url" ? source.url : `${source.type}:${source.event.id}`;
}

function getGameId(serviceId: string, escrowId: string) {
  return `${serviceId}#${escrowId}`;
}

function isApplicationSignerTrusted(_service: EscrowService, pubkey?: string) {
  return Boolean(pubkey);
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
  const status = game.creator_status || game.counterparty_status;
  if (isEscrowTerminal(status)) return status!.state;
  if (hasReachedFundingThreshold(game.creator_status) || hasReachedFundingThreshold(game.counterparty_status)) return "Ready to roll";
  if (game.counterparty_player || game.escrow.counterparty_pubkey || (game.creator_status?.total_funders ?? 0) >= 2) return "Funding";
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
