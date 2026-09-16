import "server-only";

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { finalizeEvent, getPublicKey, nip19, SimplePool, type Event } from "nostr-tools";
import { type EscrowDescriptorSource, hasReachedFundingThreshold, type FundStatusResponse, type ReleaseEscrowResponse } from "../../../../../lib/escrow";
import { createGameRecordAction, gameTip, GameRecordAction, replayGameRecord, validateGameRecordEvent } from "../../../../../lib/game-record";
import { discoverSource, readBoundedText, validateNip98Authorization } from "../../../../../lib/escrow-request";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
function relays() { const configured = process.env.NOSTR_GAME_RELAYS?.split(",").map((relay) => relay.trim()).filter(Boolean); return configured?.length ? configured : DEFAULT_RELAYS; }
function signer() {
  const configured = process.env.ROLLPOT_SERVER_NSEC?.trim() || ""; if (!configured) throw new Error("Rollpot server signing key is not configured.");
  const secretKey = /^[0-9a-f]{64}$/i.test(configured) ? hexToBytes(configured) : (() => { const decoded = nip19.decode(configured); if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) throw new Error("Invalid Rollpot server signing key."); return decoded.data; })();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}
export async function GET() { try { return Response.json({ ready: true, signer_pubkey: signer().pubkey }); } catch { return Response.json({ ready: false, signer_pubkey: null }); } }

function authPubkey(authorization: string, url: string) { validateNip98Authorization(authorization, url); return (JSON.parse(Buffer.from(authorization.slice(6), "base64").toString("utf8")) as Event).pubkey; }
async function operation<T>(url: string, authorization: string, payload: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(payload), cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const body = await readBoundedText(response, 64 * 1024); if (!response.ok) throw new Error(`Escrow request failed (${response.status}): ${body.slice(0, 300)}`); return JSON.parse(body) as T;
}
async function publish(pool: SimplePool, event: Event) {
  const destinations = relays(); const known = await pool.querySync(destinations, { ids: [event.id], limit: 1 }, { maxWait: 2000 }); if (known.some((candidate) => candidate.id === event.id)) return;
  let timer: ReturnType<typeof setTimeout> | undefined; try { const results = await Promise.race([Promise.allSettled(pool.publish(destinations, event)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Coordination publication timed out.")), 8000); })]); if (!results.some((result) => result.status === "fulfilled")) throw new Error("No Nostr relay accepted the coordination event."); } finally { if (timer) clearTimeout(timer); }
}
function expectedFrom(root: Event) {
  const value = JSON.parse(root.content) as { terms: { escrow_id: string; service_id: string; amount_sats: string; game_mode: import("../../../../../lib/game-record").GameMode; target?: number } };
  const role = (name: string) => root.tags.find((tag) => tag[0] === "p" && tag[3] === name)?.[1] || "";
  return { escrow_id: value.terms.escrow_id, service_id: value.terms.service_id, amount_sats: Number(value.terms.amount_sats), player1: role("game/player1"), player2: role("game/player2"), game_mode: value.terms.game_mode, target: value.terms.target, escrow_authority: role("core/escrow"), descriptor_event_id: root.tags.find((tag) => tag[0] === "e" && tag[3] === "escrow-version")?.[1] || "" };
}
function decision(secretKey: Uint8Array, escrowId: string, action: "release" | "refund", recipient: "creator" | "counterparty", result: unknown) {
  const nonce = crypto.randomUUID(); const timestamp = Math.floor(Date.now() / 1000); const resultHash = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(result))));
  const canonical = `pontmore-escrow:v1:${escrowId}:${action}:${recipient}:${resultHash}:${nonce}:${timestamp}`;
  return { release_decision: "application_signed_result", recipient, nonce, timestamp, result, signatures: [{ pubkey: getPublicKey(secretKey), signature: bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(canonical)), secretKey)) }] };
}
function payoutComplete(payout: unknown) { return Boolean(payout && typeof payout === "object" && (payout as { status?: unknown }).status !== "pending_bolt11"); }

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length") || 0) > 256 * 1024) throw new Error("Coordination request is too large.");
    const body = await request.json() as { operation?: "secure" | "settle" | "refund"; journal_events?: Event[]; service_source?: EscrowDescriptorSource; fund_status_authorization?: string; economic_authorization?: string; player_names?: { creator?: string; counterparty?: string } };
    if (!body.operation || !Array.isArray(body.journal_events) || !body.journal_events.length || body.journal_events.length > 256 || !body.fund_status_authorization) throw new Error("Missing coordination or escrow authorization.");
    body.journal_events.forEach(validateGameRecordEvent); const roots = body.journal_events.filter((event) => event.kind === 7300); if (roots.length !== 1) throw new Error("Expected one coordination root.");
    const root = roots[0]; const expected = expectedFrom(root); const server = signer(); if (expected.escrow_authority !== server.pubkey) throw new Error("This Rollpot server is not the bound core/escrow authority.");
    const game = replayGameRecord(body.journal_events, expected); if (!game || game.root.id !== root.id) throw new Error("Invalid game coordination chain.");
    const service = await discoverSource(body.service_source); if (service.service_id !== expected.service_id) throw new Error("Pinned escrow service does not match the coordination.");
    if (service.source.type !== "nostr" || service.source.event.id !== game.terms.descriptor_event_id) throw new Error("The exact pinned escrow descriptor is required.");
    const descriptorD = service.source.event.tags.find((tag: string[]) => tag[0] === "d")?.[1] || "";
    if (`30361:${service.source.event.pubkey}:${descriptorD}` !== game.terms.descriptor_address || service.source.event.created_at > game.root.created_at) throw new Error("The pinned escrow descriptor event and address do not match.");
    const caller = authPubkey(body.fund_status_authorization, service.operation_urls.fund_status); if (![expected.player1, expected.player2].includes(caller)) throw new Error("Escrow status authorization must come from a player.");
    const status = await operation<FundStatusResponse>(service.operation_urls.fund_status, body.fund_status_authorization, { escrow_id: expected.escrow_id }); if (status.escrow_id !== expected.escrow_id) throw new Error("Escrow status does not match this coordination.");
    const pool = new SimplePool();
    try {
      if (body.operation === "secure") {
        if (game.accepted.size !== 2 || game.secured) throw new Error("Both player acceptances are required before core/secure.");
        if (!hasReachedFundingThreshold(status)) throw new Error("The escrow has not confirmed both stakes.");
        const event = finalizeEvent(createGameRecordAction(root, GameRecordAction.Secure, {}, Math.max(Math.floor(Date.now() / 1000), gameTip(game).created_at), gameTip(game)), server.secretKey); await publish(pool, event);
        return Response.json({ event_id: event.id, authority_event: event, escrow_state: status.state });
      }
      if (!body.economic_authorization) throw new Error("Missing escrow payout authorization.");
      const endpoint = body.operation === "settle" ? service.operation_urls.release : service.operation_urls.refund;
      if (authPubkey(body.economic_authorization, endpoint) !== caller) throw new Error("Escrow authorizations must come from the same player.");
      if (body.operation === "settle") {
        if (!game.result || !game.settlementAuthorization || game.settlement) throw new Error("A valid settlement authorization is required.");
        if (status.state === "released") throw new Error("The escrow reports released, but this request cannot prove that its payout completed.");
        const label = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : fallback;
        const creatorName = label(body.player_names?.creator, "Player 1"); const counterpartyName = label(body.player_names?.counterparty, "Player 2");
        const winner = game.result.winner; const result = { escrow_id: expected.escrow_id, result_event_id: game.result.event.id, creator_roll: game.result.creator_roll, counterparty_roll: game.result.counterparty_roll, winner, rolled_at: new Date(game.result.event.created_at * 1000).toISOString(), winner_name: winner === "creator" ? creatorName : counterpartyName, settlement_address: "" };
        const release = await operation<ReleaseEscrowResponse>(endpoint, body.economic_authorization, { escrow_id: expected.escrow_id, decision: decision(server.secretKey, expected.escrow_id, "release", winner, result) });
        if (release.escrow_id !== expected.escrow_id || release.state !== "released" || release.recipient !== winner) throw new Error("Escrow release did not confirm this game's winner.");
        if (!payoutComplete(release.payout)) return Response.json({ event_id: game.settlementAuthorization.id, escrow_state: "release_pending", release, result, settlement_error: "The escrow accepted release, but its Lightning payout still needs reconciliation." });
        const event = finalizeEvent(createGameRecordAction(root, GameRecordAction.Settle, { evidence: [{ type: "opaque", value: `escrow:${expected.escrow_id}:release` }] }, Math.max(Math.floor(Date.now() / 1000), gameTip(game).created_at), gameTip(game)), server.secretKey); await publish(pool, event);
        return Response.json({ event_id: event.id, authority_event: event, escrow_state: "released", release, result });
      }
      if (!game.refundAuthorization || game.refund) throw new Error("A valid refund authorization is required.");
      const result = { escrow_id: expected.escrow_id, refund_authorization_event_id: game.refundAuthorization.id };
      const refund = await operation<{ escrow_id: string; state: "refunded"; refunds?: Array<{ payout?: unknown }> }>(endpoint, body.economic_authorization, { escrow_id: expected.escrow_id, decision: decision(server.secretKey, expected.escrow_id, "refund", "creator", result) });
      if (refund.escrow_id !== expected.escrow_id || refund.state !== "refunded") throw new Error("Escrow did not confirm the refund.");
      if (!refund.refunds?.length || !refund.refunds.every((item) => payoutComplete(item.payout))) return Response.json({ event_id: game.refundAuthorization.id, escrow_state: "refund_pending", refund, settlement_error: "The escrow accepted refund, but one or more payouts need reconciliation." });
      const event = finalizeEvent(createGameRecordAction(root, GameRecordAction.Refund, { evidence: [{ type: "opaque", value: `escrow:${expected.escrow_id}:refund` }] }, Math.max(Math.floor(Date.now() / 1000), gameTip(game).created_at), gameTip(game)), server.secretKey); await publish(pool, event);
      return Response.json({ event_id: event.id, authority_event: event, escrow_state: "refunded", refund });
    } finally { pool.destroy(); }
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Coordination authority operation failed." }, { status: 400 }); }
}
