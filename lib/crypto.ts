"use client";

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { DiceGameResult, EscrowIdentity, NostrEvent, PlayerProfile } from "./escrow";

const LOCAL_PLAYER_SECRET_STORAGE = "rollpot-local-player-secret";
const PLAYER_PROFILE_STORAGE = "rollpot-player-profile";

type NostrExtension = {
  getPublicKey?: () => Promise<string>;
  signEvent?: (event: Omit<NostrEvent, "id" | "sig">) => Promise<NostrEvent>;
};

declare global {
  interface Window {
    nostr?: NostrExtension;
  }
}

export function loadOrCreateIdentity(label: string, storageKey: string): EscrowIdentity {
  const stored = window.localStorage.getItem(storageKey);
  const secretKey = stored ? hexToBytes(stored) : generateSecretKey();

  if (!stored) {
    window.localStorage.setItem(storageKey, bytesToHex(secretKey));
  }

  return {
    label,
    secretKey,
    pubkey: getPublicKey(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

export async function loadCurrentPlayer(): Promise<{ identity: EscrowIdentity; profile: PlayerProfile } | null> {
  const savedProfile = readSavedProfile();
  const extensionPubkey = await window.nostr?.getPublicKey?.().catch(() => "");

  if (extensionPubkey && window.nostr?.signEvent) {
    return buildExtensionPlayer(extensionPubkey, savedProfile);
  }

  const storedLocalSecret = window.localStorage.getItem(LOCAL_PLAYER_SECRET_STORAGE);

  if (!storedLocalSecret) {
    return null;
  }

  const identity = localPlayerFromSecret(hexToBytes(storedLocalSecret));

  return {
    identity,
    profile: {
      name: savedProfile?.pubkey === identity.pubkey ? savedProfile.name : "Local player",
      npub: identity.npub,
      pubkey: identity.pubkey,
      lightning_address: savedProfile?.pubkey === identity.pubkey ? savedProfile.lightning_address : "",
    },
  };
}

export async function connectNostrPlayer(): Promise<{ identity: EscrowIdentity; profile: PlayerProfile }> {
  const pubkey = await window.nostr?.getPublicKey?.();

  if (!pubkey || !window.nostr?.signEvent) {
    throw new Error("Install or unlock a Nostr signer extension to log in.");
  }

  return buildExtensionPlayer(pubkey, readSavedProfile());
}

export function createLocalNostrPlayer(): { identity: EscrowIdentity; profile: PlayerProfile } {
  const identity = loadOrCreateIdentity("Local Nostr player", LOCAL_PLAYER_SECRET_STORAGE);
  const savedProfile = readSavedProfile();

  return {
    identity,
    profile: {
      name: savedProfile?.pubkey === identity.pubkey ? savedProfile.name : "Local player",
      npub: identity.npub,
      pubkey: identity.pubkey,
      lightning_address: savedProfile?.pubkey === identity.pubkey ? savedProfile.lightning_address : "",
    },
  };
}

export function savePlayerProfile(profile: PlayerProfile) {
  window.localStorage.setItem(PLAYER_PROFILE_STORAGE, JSON.stringify(profile));
}

export async function loadNostrProfile(pubkey: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`/api/nostr/profile?pubkey=${encodeURIComponent(pubkey)}`, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load Nostr profile.");
  return body.metadata;
}

export async function publishPlayerProfile(identity: EscrowIdentity, profile: PlayerProfile) {
  if (profile.pubkey !== identity.pubkey || !profile.name.trim() || !profile.lightning_address.trim()) {
    throw new Error("Complete your player profile before publishing it to Nostr.");
  }

  const metadata = await loadNostrProfile(identity.pubkey);
  const unsigned = {
    kind: 0,
    pubkey: identity.pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [] as string[][],
    content: JSON.stringify({ ...metadata, name: profile.name.trim(), lud16: profile.lightning_address.trim() }),
  };
  const event = identity.signEvent
    ? await identity.signEvent(unsigned)
    : finalizeEvent(unsigned, identity.secretKey!);
  if (event.pubkey !== identity.pubkey) throw new Error("The signer returned a different Nostr identity.");

  const response = await fetch("/api/nostr/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not publish Nostr profile.");
  return body as { event_id: string; published: string[] };
}

export async function buildNip98Authorization(identity: EscrowIdentity, method: string, url: string) {
  const unsigned = {
    kind: 27235,
    pubkey: identity.pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", method],
    ],
    content: "",
  } satisfies Omit<NostrEvent, "id" | "sig">;
  const event = identity.signEvent
    ? await identity.signEvent(unsigned)
    : (finalizeEvent(unsigned, identity.secretKey!) as NostrEvent);

  return `Nostr ${btoa(JSON.stringify(event))}`;
}

export function buildApplicationReleaseDecision({
  appSigner,
  escrowId,
  result,
  nonce,
  timestamp,
}: {
  appSigner: EscrowIdentity;
  escrowId: string;
  result: DiceGameResult;
  nonce: string;
  timestamp: number;
}) {
  if (!appSigner.secretKey) {
    throw new Error("Rollpot application signer is unavailable.");
  }

  const resultPayload = { ...result };
  const resultHash = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(resultPayload))));
  const canonicalMessage = `pontmore-escrow:v1:${escrowId}:release:${result.winner}:${resultHash}:${nonce}:${timestamp}`;
  const msgHash = sha256(new TextEncoder().encode(canonicalMessage));
  const signature = bytesToHex(schnorr.sign(msgHash, appSigner.secretKey));

  return {
    release_decision: "application_signed_result",
    recipient: result.winner,
    nonce,
    timestamp,
    result: resultPayload,
    signatures: [
      {
        pubkey: appSigner.pubkey,
        signature,
      },
    ],
  };
}

export function rollDie(avoidTieWith?: number): number {
  const roll = crypto.getRandomValues(new Uint32Array(1))[0] % 6 + 1;

  if (avoidTieWith && roll === avoidTieWith) {
    return rollDie(avoidTieWith);
  }

  return roll;
}

function readSavedProfile(): PlayerProfile | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PLAYER_PROFILE_STORAGE) || "null") as PlayerProfile | null;

    if (!parsed?.pubkey || !parsed.npub) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function buildExtensionPlayer(pubkey: string, savedProfile: PlayerProfile | null) {
  const npub = nip19.npubEncode(pubkey);
  const identity: EscrowIdentity = {
    label: "Nostr signer",
    pubkey,
    npub,
    signEvent: (event) => window.nostr!.signEvent!(event),
  };

  return {
    identity,
    profile: {
      name: savedProfile?.pubkey === pubkey ? savedProfile.name : "Nostr player",
      npub,
      pubkey,
      lightning_address: savedProfile?.pubkey === pubkey ? savedProfile.lightning_address : "",
    },
  };
}

function localPlayerFromSecret(secretKey: Uint8Array): EscrowIdentity {
  const pubkey = getPublicKey(secretKey);

  return {
    label: "Local Nostr player",
    secretKey,
    pubkey,
    npub: nip19.npubEncode(pubkey),
  };
}
