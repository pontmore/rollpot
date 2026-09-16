import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { bindRootProposer, createGameRecordAction, createGameRecordRoot, GameMode, GameRecordAction, GameRecordPhase, replayGameRecord } from "../lib/game-record.ts";

const player1Secret = generateSecretKey();
const player2Secret = generateSecretKey();
const serverSecret = generateSecretKey();
const otherSecret = generateSecretKey();
const player1 = getPublicKey(player1Secret);
const player2 = getPublicKey(player2Secret);
const server = getPublicKey(serverSecret);
const descriptorSecret = generateSecretKey();
const descriptorPubkey = getPublicKey(descriptorSecret);
const descriptor = finalizeEvent({ kind: 30361, created_at: 80, tags: [["d", "test"]], content: "{}" }, descriptorSecret);
const base = { escrow_id: "11111111-2222-4333-8444-555555555555", service_id: "service-1", amount_sats: 100, player1, player2, game_mode: GameMode.HigherRollWins, escrow_authority: server, descriptor_event_id: descriptor.id };

function sign(template, secret) { return finalizeEvent(template, secret); }
function root(mode = GameMode.HigherRollWins, target) {
  return sign(bindRootProposer(createGameRecordRoot({ escrow_id: base.escrow_id, service_id: base.service_id, amount_sats: base.amount_sats, counterparty_pubkey: player2, escrow_authority_pubkey: server, descriptor_event_id: descriptor.id, descriptor_address: `30361:${descriptorPubkey}:test`, game_mode: mode, ...(target ? { target } : {}), expires_at: 110, fund_by: 120, result_by: 180, recover_by: 240 }, 100), player1), player1Secret);
}
function action(rootEvent, predecessor, type, data, at, secret) { return sign(createGameRecordAction(rootEvent, type, data, at, predecessor), secret); }
function securedFixture(mode = GameMode.HigherRollWins, target) {
  const r = root(mode, target); const a1 = action(r, r, GameRecordAction.Accept, {}, 101, player1Secret); const a2 = action(r, a1, GameRecordAction.Accept, {}, 102, player2Secret); const secure = action(r, a2, GameRecordAction.Secure, {}, 103, serverSecret);
  return { root: r, actions: [a1, a2, secure] };
}
function expected(mode = GameMode.HigherRollWins, target) { return { ...base, game_mode: mode, ...(target ? { target } : {}) }; }

test("root pins profile roles, descriptor, service and deadlines", () => {
  const r = root(); const game = replayGameRecord([r], expected());
  assert.equal(game?.root.kind, 7300); assert.equal(game?.terms.escrow_authority_pubkey, server); assert.equal(game?.terms.descriptor_event_id, descriptor.id); assert.equal(game?.phase, GameRecordPhase.Proposed);
});

test("only the bound server can secure after both player acceptances", () => {
  const f = securedFixture(); assert.equal(replayGameRecord([f.root, ...f.actions], expected())?.secured, true);
  const bad = action(f.root, f.actions[1], GameRecordAction.Secure, {}, 103, otherSecret);
  assert.throws(() => replayGameRecord([f.root, f.actions[0], f.actions[1], bad], expected()), /core\/secure authority/);
});

test("actions form one linear chain and forks freeze progression", () => {
  const r = root(); const a1 = action(r, r, GameRecordAction.Accept, {}, 101, player1Secret); const competing = action(r, r, GameRecordAction.Accept, {}, 101, player2Secret);
  assert.throws(() => replayGameRecord([r, a1, competing], expected()), /Forked/);
});

test("both players roll and the pinned higher-roll rule derives the result", () => {
  const f = securedFixture(); const first = action(f.root, f.actions.at(-1), GameRecordAction.Roll, { round: 1, value: 2 }, 104, player1Secret); const second = action(f.root, first, GameRecordAction.Roll, { round: 1, value: 6 }, 105, player2Secret); const result = action(f.root, second, GameRecordAction.Result, { round: 1, creator_roll: 2, counterparty_roll: 6, winner: "counterparty" }, 106, player1Secret);
  const game = replayGameRecord([f.root, ...f.actions, first, second, result], expected()); assert.equal(game?.result?.winner, "counterparty"); assert.equal(game?.phase, GameRecordPhase.Result);
});

test("target games repeat a round unless exactly one player hits", () => {
  const f = securedFixture(GameMode.RollToTarget, 6); const r1a = action(f.root, f.actions.at(-1), GameRecordAction.Roll, { round: 1, value: 2 }, 104, player1Secret); const r1b = action(f.root, r1a, GameRecordAction.Roll, { round: 1, value: 4 }, 105, player2Secret); const r2a = action(f.root, r1b, GameRecordAction.Roll, { round: 2, value: 6 }, 106, player1Secret); const r2b = action(f.root, r2a, GameRecordAction.Roll, { round: 2, value: 1 }, 107, player2Secret);
  const game = replayGameRecord([f.root, ...f.actions, r1a, r1b, r2a, r2b], expected(GameMode.RollToTarget, 6)); assert.equal(game?.currentRound, 2); assert.equal(game?.pendingResult?.winner, "creator");
});

test("settlement requires player authorization and the bound server", () => {
  const f = securedFixture(); const roll1 = action(f.root, f.actions.at(-1), GameRecordAction.Roll, { round: 1, value: 6 }, 104, player1Secret); const roll2 = action(f.root, roll1, GameRecordAction.Roll, { round: 1, value: 2 }, 105, player2Secret); const result = action(f.root, roll2, GameRecordAction.Result, { round: 1, creator_roll: 6, counterparty_roll: 2, winner: "creator" }, 106, player1Secret); const authorize = action(f.root, result, GameRecordAction.AuthorizeSettlement, { evidence: [{ type: "event", value: result.id }] }, 107, player1Secret); const settle = action(f.root, authorize, GameRecordAction.Settle, { evidence: [{ type: "opaque", value: "escrow:released" }] }, 108, serverSecret);
  const game = replayGameRecord([f.root, ...f.actions, roll1, roll2, result, authorize, settle], expected()); assert.equal(game?.phase, GameRecordPhase.Settled);
});

test("refund requires a deadline authorization followed by the bound server", () => {
  const f = securedFixture(); const authorize = action(f.root, f.actions.at(-1), GameRecordAction.AuthorizeRefund, { evidence: [{ type: "opaque", value: "recovery-timeout" }] }, 241, player2Secret); const refund = action(f.root, authorize, GameRecordAction.Refund, { evidence: [{ type: "opaque", value: "escrow:refunded" }] }, 242, serverSecret);
  assert.equal(replayGameRecord([f.root, ...f.actions, authorize, refund], expected())?.phase, GameRecordPhase.Refunded);
});

test("only the proposer can cancel before acceptance", () => {
  const r = root(); const cancel = action(r, r, GameRecordAction.Cancel, {}, 101, player1Secret);
  assert.equal(replayGameRecord([r, cancel], expected())?.phase, GameRecordPhase.Cancelled);
  const invalid = action(r, r, GameRecordAction.Cancel, {}, 101, player2Secret);
  assert.throws(() => replayGameRecord([r, invalid], expected()), /proposer/);
});

test("an unaccepted root can expire only after its deadline", () => {
  const r = root(); const early = action(r, r, GameRecordAction.Expire, {}, 109, player2Secret);
  assert.throws(() => replayGameRecord([r, early], expected()), /expire/);
  const expired = action(r, r, GameRecordAction.Expire, {}, 110, player2Secret);
  assert.equal(replayGameRecord([r, expired], expected())?.phase, GameRecordPhase.Expired);
});

test("the expected adapter and descriptor must match the root", () => {
  const r = root(); assert.throws(() => replayGameRecord([r], { ...expected(), escrow_authority: getPublicKey(otherSecret) }), /does not match/); assert.throws(() => replayGameRecord([r], { ...expected(), descriptor_event_id: "0".repeat(64) }), /does not match/);
});
