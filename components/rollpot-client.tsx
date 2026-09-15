"use client";

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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DiceFace } from "./dice-face";
import { FundingStatusCard, KeyValue } from "./status-card";
import {
  buildApplicationReleaseDecision,
  buildNip98Authorization,
  connectNostrPlayer,
  createLocalNostrPlayer,
  loadCurrentPlayer,
  loadNostrProfile,
  loadOrCreateIdentity,
  publishPlayerProfile,
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
  hasReachedFundingThreshold,
  isEscrowTerminal,
  isOwnPaymentConfirmed,
} from "../lib/escrow";

const APP_SECRET_STORAGE = "pontmore-rollpot-app-secret";
const GAMES_STORAGE = "pontmore-dice-games";
const SELECTED_SERVICE_STORAGE = "pontmore-rollpot-selected-service";

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
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profilePublishBusy, setProfilePublishBusy] = useState(false);
  const [profilePublishNotice, setProfilePublishNotice] = useState("");
  const [playMode, setPlayMode] = useState<"create" | "join">("create");
  const [escrowDetailsOpen, setEscrowDetailsOpen] = useState(false);
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
  const [trackedGames, setTrackedGames] = useState<TrackedDiceGame[]>([]);
  const [activeGameId, setActiveGameId] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [gameMissing, setGameMissing] = useState(false);
  const validatedServiceRef = useRef<EscrowService | null>(null);
  const validatedSourceRef = useRef<string>("");

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
    setAppSigner(loadOrCreateIdentity("Rollpot application", APP_SECRET_STORAGE));
  }, []);

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
      if (savedService) {
        setService(savedService);
        setServiceSelected(true);
        setDescriptorInput(savedService.source.type === "url" ? savedService.source.url : "");
        if (page === "escrows") {
          setCatalog((current) => [
            {
              service: savedService,
              descriptor: savedService.descriptor,
              source: savedService.source,
              publisher_pubkey: savedService.source.type === "nostr" ? savedService.source.event.pubkey : "",
              identifier: serviceLabel(savedService),
              compatible: true,
              compatibility_status: "standalone_compatible",
            },
            ...current.filter((entry) => entry.service?.service_id !== savedService.service_id),
          ]);
        }
      }
    }
    setHydrated(true);
    return () => { cancelled = true; };
  }, [page, gameId]);

  useEffect(() => {
    if (playerProfile) {
      savePlayerProfile(playerProfile);
    }
  }, [playerProfile]);

  const fundingModel = escrow?.funding_model || "2_of_2";
  const appSignerTrusted = Boolean(appSigner);
  const canAuthenticate = Boolean(playerIdentity && playerProfile?.lightning_address && appSigner);
  const canCallService = Boolean(hydrated && serviceSelected && service?.endpoint && canAuthenticate && appSignerTrusted && !escrow);
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
  const gameEnded = Boolean(releaseResponse || isEscrowTerminal(technicalStatus));
  const allPaid = Boolean(escrow?.funding_model === "2_of_2" && (paymentsReady || releaseResponse?.state === "released" || technicalStatus?.state === "released"));
  const creatorPaid = Boolean(allPaid || isOwnPaymentConfirmed(creatorStatus));
  const counterpartyPaid = Boolean(allPaid || isOwnPaymentConfirmed(counterpartyStatus));
  const fundedCounts = [creatorStatus?.funded_count, counterpartyStatus?.funded_count].filter((count): count is number => count != null);
  const fundedCount = fundedCounts.length ? Math.max(...fundedCounts) : null;
  const fundingThreshold = technicalStatus?.funding_threshold ?? escrow?.funding_threshold ?? 2;
  const inviteFundingDeadline = trackedGames.find((game) => game.id === activeGameId)?.invite_funding_deadline;
  const escrowStateSummary = `${releaseResponse?.state || technicalStatus?.state || escrow?.state || "unknown"}${fundedCount != null ? ` · ${fundedCount}/${fundingThreshold} funded` : allPaid ? " · fully funded" : ""}`;
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
      funding_deadline: escrow.funding_deadline,
      service_source: service.source,
    });
  }, [creatorPlayer, escrow, localRole, releaseResponse, service?.source]);

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
        funding_model: "2_of_2",
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

  async function joinInvite() {
    if (!playerIdentity || !playerProfile) return;
    assertPlayableProfile(playerProfile);

    const invite = decodeInvite(inviteInput);

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
      const joined = await callEscrow<CreateEscrowResponse>(playerIdentity, "create", {
        enrollment_token: invite.enrollment_token,
        refund_ln_address: playerProfile.lightning_address,
      }, inviteService);
      if (joined.escrow_id !== invite.escrow_id) throw new Error("Joined escrow did not match the invite.");
      const game = { ...baseTrackedGame({
        escrow: joined,
        service: inviteService,
        role: "counterparty",
        creator: invite.creator_player,
        counterparty: playerProfile,
      }), invite_funding_deadline: invite.funding_deadline };

      applyTrackedGame(game);
      saveTrackedGame(game);
      setInviteInput("");
      router.push(gamePath(game));
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
    if (!escrow || !appSigner || !playerIdentity || !gameIdentityMatches) return;

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
    setProfilePublishNotice("");
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
    setDescriptorInput(nextService.source.type === "url" ? nextService.source.url : "");
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
                <Chip icon={<CasinoIcon />} label="Rollpot" color="primary" sx={{ mb: 1.5 }} />
                <Typography component="h1" variant={page === "home" ? "h2" : "h3"} sx={{ fontWeight: 900, letterSpacing: 0 }}>
                  {page === "home" ? "Rollpot" : page === "escrows" ? "Escrows" : page === "games" ? "Games" : escrow
                    ? `${creatorPlayer?.name || "Player 1"} vs ${counterpartyPlayer?.name || "Player 2"}`
                    : "Game"}
                </Typography>
                <Typography color="text.secondary">
                  {page === "home"
                    ? "Invite a Nostr player, fund the pot, roll once."
                    : page === "escrows"
                      ? "Choose the escrow service for your next game."
                      : page === "games"
                        ? "Your saved games, newest first."
                      : escrow ? `${escrow.amount_sats * 2} sats pot · ${gameEnded ? "Ended" : !playerJoined ? "Waiting for Player 2" : paymentsReady ? "Ready to roll" : "Funding"}` : "Your saved game"}
                </Typography>
              </Box>
              {page === "game" ? (
                <Stack spacing={1.5} sx={{ alignItems: { md: "flex-end" } }}>
                  <Button component={Link} href="/games" variant="outlined" size="small">All games</Button>
                  {gameResult ? <Stack direction="row" spacing={2}>
                    <DiceFace label={creatorPlayer?.name || "Player 1"} value={gameResult.creator_roll} />
                    <DiceFace label={counterpartyPlayer?.name || "Player 2"} value={gameResult.counterparty_roll} />
                  </Stack> : null}
                </Stack>
              ) : (
                <Stack direction="row" spacing={1}>
                  {page !== "home" ? <Button component={Link} href="/" variant="outlined">Home</Button> : null}
                  {page === "home" ? <Button component={Link} href="/escrows" variant="outlined">Escrows</Button> : null}
                </Stack>
              )}
            </Stack>
          </Paper>

          {busy ? <LinearProgress /> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          {page === "home" && serviceSelected && !appSignerTrusted ? (
            <Alert severity="error">
              This escrow does not trust this Rollpot application signer. Creating a game would leave Rollpot unable to release the wager.
            </Alert>
          ) : null}
          {page === "home" && !serviceSelected ? <Alert severity="info">Select an escrow before creating a game.</Alert> : null}

          {page === "escrows" ? <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 2 }}>
              <Stack spacing={1.5} sx={{ mb: 2 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                  <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>Available escrows</Typography>
                    <Typography variant="body2" color="text.secondary">Query PIP-01 descriptors from public Nostr relays, then select one for a new game.</Typography>
                  </Box>
                  <Button size="small" variant="contained" onClick={() => void loadEscrowCatalog()} disabled={catalogBusy}>
                    {catalogBusy ? "Discovering..." : "Discover escrows"}
                  </Button>
                </Stack>
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
                        <Paper key={serializeSource(entry.source)} variant="outlined" sx={{ p: 1.5 }}>
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
              </Stack>
            <>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>Direct URL fallback</Typography>
                <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} sx={{ alignItems: { md: "flex-start" } }}>
                  <TextField
                    label="Escrow descriptor URL"
                    value={descriptorInput}
                    onChange={(event) => setDescriptorInput(event.target.value)}
                    size="small"
                    fullWidth
                    helperText={service ? `${service.descriptor.escrow_type} · ${service.descriptor.networks.join(", ")} · ${service.funding_models?.join(", ") || "escrow"}` : "No escrow selected yet"}
                  />
                  <Button disabled={discoveryBusy || !descriptorInput.trim()} variant="outlined" onClick={selectDescriptor} sx={{ minWidth: 120 }}>
                    Validate URL
                  </Button>
                </Stack>
              </>
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
                      </> : <>
                      <TextField label="Invite code" value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} size="small" multiline minRows={3} />
                      <Button disabled={!canAuthenticate || !inviteInput.trim() || busy} variant="outlined" onClick={joinInvite} startIcon={<LoginIcon />}>
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
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>
                        {gameEnded ? "Game over" : !playerJoined ? "Invite Player 2" : paymentsReady ? "Ready to roll" : "Fund the pot"}
                      </Typography>

                      {escrow ? (
                        <Stack spacing={2.25}>
                        {authLoaded && !gameIdentityMatches ? (
                          <Alert severity="warning">
                            Sign in on the home page with the Nostr identity used for this game before requesting payment or rolling.
                          </Alert>
                        ) : null}
                        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                          <PlayerLine label="Player 1" profile={creatorPlayer} ready={Boolean(creatorPlayer)} paid={creatorPaid} />
                          <PlayerLine label="Player 2" profile={counterpartyPlayer} ready={playerJoined} paid={counterpartyPaid} />
                        </Stack>

                          {inviteCode && !playerJoined ? <InviteCode code={inviteCode} /> : null}

                          {playerJoined && !paymentsReady && !gameEnded ? (
                          <FundingStatusCard
                            title={`Pay ${escrow.amount_sats} sats`}
                            disabled={!canRequestPayment || busy}
                            instructions={myFunding}
                            status={myStatus}
                            onInstructions={loadMyFunding}
                            onStatus={refreshMyStatus}
                          />
                          ) : null}

                          {paymentsReady && !gameEnded ? <Alert severity="success">Both payments received.</Alert> : null}
                          {paymentsReady && !gameEnded ? <Button disabled={!gameIdentityMatches || busy} variant="contained" color="secondary" onClick={rollAndRelease} startIcon={<CasinoIcon />}>
                            Roll
                          </Button> : null}
                          {releaseResponse ? (
                            <Alert severity="success">
                              {winnerLabel(releaseResponse.recipient, {
                                creator_player: creatorPlayer || fallbackPlayer("Player 1"),
                                counterparty_player: counterpartyPlayer,
                              })} {releaseResponse.payout_sats} sats.
                            </Alert>
                          ) : null}
                          {!releaseResponse && isEscrowTerminal(technicalStatus) ? <Alert severity="info">The escrow is {technicalStatus?.state}. Check Escrow state for details.</Alert> : null}
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
                    </Stack> : null}
                  </Stack>
                </CardContent>
              </Card> : null}
            </Stack>
          </Stack> : null}
        </Stack>
      </Container>

      {page === "escrows" ? <EscrowDetailDialog entry={detailEntry} onClose={() => setDetailEntry(null)} appSigner={appSigner} onSelect={selectService} canSelect={(entry) => entry.compatible && Boolean(entry.service) && isApplicationSignerTrusted(entry.service!, appSigner?.pubkey)} /> : null}
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
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 900 }}>Invite Player 2</Typography>
        <Button size="small" variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => navigator.clipboard.writeText(code)}>
          Copy invite
        </Button>
      </Stack>
      <TextField
        label="Invite code"
        value={code}
        size="small"
        fullWidth
        slotProps={{ input: { readOnly: true } }}
        sx={{ "& input": { textOverflow: "ellipsis" } }}
      />
    </Stack>
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

function decodeInvite(value: string): GameInvite {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const invite = JSON.parse(atob(padded)) as GameInvite;

  if (
    invite.version !== 1 ||
    invite.game !== "rollpot" ||
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
        <Chip size="small" label={paid ? "paid" : ready ? "joined" : "waiting"} color={paid ? "success" : "default"} />
      </Stack>
    </Stack>
  );
}
