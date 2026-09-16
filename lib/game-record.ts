import { verifyEvent, type Event, type EventTemplate } from "nostr-tools";

export const GAME_ROOT_KIND = 7300;
export const GAME_ACTION_KIND = 7301;
export const GAME_PROFILE = "rollpot/game@1";
export const GAME_RECORD_VERSION = 2;

export enum GameRecordVersion { Current = 2 }
export enum GameRecordAction {
  Root = "root", Accept = "core/accept", Secure = "core/secure", Roll = "game/roll", Result = "game/result",
  AuthorizeSettlement = "core/authorize_settlement", Settle = "core/settle",
  AuthorizeRefund = "core/authorize_refund", Refund = "core/refund", Cancel = "core/cancel", Expire = "core/expire",
}
export enum GameRecordPhase {
  Proposed = "proposed", Funding = "funding", Secured = "secured", Rolling = "rolling", Result = "result",
  SettlementAuthorized = "settlement_authorized", Settled = "settled", RefundAuthorized = "refund_authorized",
  Refunded = "refunded", Cancelled = "cancelled", Expired = "expired",
}
export enum GameMode { HigherRollWins = "higher_roll_wins", LowerRollWins = "lower_roll_wins", RollToTarget = "roll_to_target" }
export enum GameWinner { Creator = "creator", Counterparty = "counterparty" }

export type GameRecordRoot = {
  escrow_id: string; service_id: string; amount_sats: number; counterparty_pubkey: string; escrow_authority_pubkey: string;
  descriptor_event_id: string; descriptor_address: string; game_mode: GameMode; target?: number;
  expires_at: number; fund_by: number; result_by: number; recover_by: number;
};
export type GameRoll = { event: Event; round: number; value: number };
export type GameRound = { creator?: GameRoll; counterparty?: GameRoll };
export type GameRoundResult = { round: number; creator_roll: number; counterparty_roll: number; winner: GameWinner };
export type GameRecord = {
  root: Event; version: GameRecordVersion; mode: GameMode; target?: number; terms: GameRecordRoot; actions: Event[];
  accepted: Set<string>; secured: boolean; rolls: Map<number, GameRound>; currentRound: number; phase: GameRecordPhase;
  pendingResult?: GameRoundResult; result?: GameRoundResult & { event: Event }; settlementAuthorization?: Event;
  settlement?: Event; refundAuthorization?: Event; refund?: Event; cancellation?: Event; expiration?: Event;
};

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Game event content must be an object."); return value as Record<string, unknown>; }
function content(event: Event) { try { return object(JSON.parse(event.content)); } catch { throw new Error("Game event content must be JSON."); } }
function exactKeys(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error("Unsupported game event fields."); }
function rolePubkey(root: Event, role: string) { const found = root.tags.filter((tag) => tag[0] === "p" && tag[3] === role); if (found.length !== 1 || !HEX64.test(found[0][1] || "")) throw new Error(`Game root needs one ${role} role.`); return found[0][1]; }
function tagged(root: Event, name: string, marker: string) { return root.tags.filter((tag) => tag[0] === name && tag[3] === marker); }
function refs(event: Event) { const root = tagged(event, "e", "root"); const prev = tagged(event, "e", "prev"); if (root.length !== 1 || prev.length !== 1 || !HEX64.test(root[0][1] || "") || !HEX64.test(prev[0][1] || "")) throw new Error("Game action needs one root and predecessor reference."); return { root: root[0][1], prev: prev[0][1] }; }

function rootTerms(root: Event): GameRecordRoot {
  const value = content(root); const terms = object(value.terms);
  return {
    escrow_id: String(terms.escrow_id || ""), service_id: String(terms.service_id || ""), amount_sats: Number(terms.amount_sats),
    counterparty_pubkey: rolePubkey(root, "game/player2"), escrow_authority_pubkey: rolePubkey(root, "core/escrow"),
    descriptor_event_id: tagged(root, "e", "escrow-version")[0]?.[1] || "", descriptor_address: tagged(root, "a", "escrow")[0]?.[1] || "",
    game_mode: terms.game_mode as GameMode, ...(terms.target === undefined ? {} : { target: Number(terms.target) }),
    expires_at: Number(value.expires_at), fund_by: Number(terms.fund_by), result_by: Number(terms.result_by), recover_by: Number(terms.recover_by),
  };
}

function validateRoot(event: Event) {
  if (event.kind !== GAME_ROOT_KIND || !verifyEvent(event) || event.content.length > 4096) throw new Error("Invalid signed PIP-02 game root.");
  if (event.tags.some((tag) => !["p", "e", "a", "t"].includes(tag[0])) || event.tags.filter((tag) => tag[0] === "p").length !== 3 || event.tags.filter((tag) => tag[0] === "e").length !== 1 || event.tags.filter((tag) => tag[0] === "a").length !== 1 || event.tags.filter((tag) => tag[0] === "t").length !== 2 ||
    ["game/player1", "game/player2", "core/escrow"].some((role) => event.tags.filter((tag) => tag[0] === "p" && tag[3] === role).length !== 1) ||
    event.tags.some((tag) => tag[0] === "p" && !["game/player1", "game/player2", "core/escrow"].includes(tag[3] || "")) ||
    event.tags.filter((tag) => tag[0] === "t" && tag[1] === GAME_PROFILE).length !== 1) throw new Error("Invalid game root tags.");
  const value = content(event); exactKeys(value, ["version", "profile", "terms", "expires_at"]);
  if (value.version !== GAME_RECORD_VERSION || value.profile !== GAME_PROFILE) throw new Error("Unsupported game coordination profile.");
  const raw = object(value.terms); exactKeys(raw, ["escrow_id", "service_id", "amount_sats", "funding_model", "payout_network", "game_mode", ...(raw.target === undefined ? [] : ["target"]), "fund_by", "result_by", "recover_by"]);
  const terms = rootTerms(event); const player1 = rolePubkey(event, "game/player1");
  if (player1 !== event.pubkey || terms.counterparty_pubkey === player1 || [player1, terms.counterparty_pubkey].includes(terms.escrow_authority_pubkey)) throw new Error("Invalid game root role binding.");
  if (!UUID.test(terms.escrow_id) || !terms.service_id || terms.service_id.length > 512 || !Number.isSafeInteger(terms.amount_sats) || terms.amount_sats <= 0 || raw.funding_model !== "2_of_2" || raw.payout_network !== "lightning") throw new Error("Invalid game root terms.");
  if (event.tags.filter((tag) => tag[0] === "t" && tag[1] === gameEscrowTag(terms.escrow_id)).length !== 1) throw new Error("Invalid game escrow discovery tag.");
  if (!Object.values(GameMode).includes(terms.game_mode) || (terms.game_mode === GameMode.RollToTarget ? !Number.isInteger(terms.target) || terms.target! < 1 || terms.target! > 6 : terms.target !== undefined)) throw new Error("Invalid game mode or target.");
  if (![terms.expires_at, terms.fund_by, terms.result_by, terms.recover_by].every(Number.isSafeInteger) || !(event.created_at <= terms.expires_at && terms.expires_at < terms.fund_by && terms.fund_by < terms.result_by && terms.result_by < terms.recover_by)) throw new Error("Invalid game deadlines.");
  if (tagged(event, "e", "escrow-version").length !== 1 || !HEX64.test(terms.descriptor_event_id) || tagged(event, "a", "escrow").length !== 1 || !/^30361:[0-9a-f]{64}:[^:]+$/.test(terms.descriptor_address)) throw new Error("Invalid pinned escrow descriptor.");
}

function validateAction(event: Event) {
  if (event.kind !== GAME_ACTION_KIND || !verifyEvent(event) || event.content.length > 4096) throw new Error("Invalid signed PIP-02 game action."); refs(event);
  if (event.tags.some((tag) => tag[0] !== "e" && tag[0] !== "p")) throw new Error("Invalid game action tags.");
  const value = content(event); const action = value.action as GameRecordAction;
  if (value.version !== GAME_RECORD_VERSION || !Object.values(GameRecordAction).includes(action) || action === GameRecordAction.Root) throw new Error("Unsupported game action.");
  exactKeys(value, ["version", "action", ...(value.data === undefined ? [] : ["data"])]); const data = value.data === undefined ? {} : object(value.data);
  if ([GameRecordAction.Accept, GameRecordAction.Secure, GameRecordAction.Cancel, GameRecordAction.Expire].includes(action)) exactKeys(data, []);
  else if (action === GameRecordAction.Roll) { exactKeys(data, ["round", "value"]); if (!Number.isSafeInteger(data.round) || Number(data.round) < 1 || !Number.isInteger(data.value) || Number(data.value) < 1 || Number(data.value) > 6) throw new Error("Invalid game roll."); }
  else if (action === GameRecordAction.Result) { exactKeys(data, ["round", "creator_roll", "counterparty_roll", "winner"]); if (!Number.isSafeInteger(data.round) || Number(data.round) < 1 || !Number.isInteger(data.creator_roll) || Number(data.creator_roll) < 1 || Number(data.creator_roll) > 6 || !Number.isInteger(data.counterparty_roll) || Number(data.counterparty_roll) < 1 || Number(data.counterparty_roll) > 6 || !Object.values(GameWinner).includes(data.winner as GameWinner)) throw new Error("Invalid game result."); }
  else { exactKeys(data, ["evidence"]); if (!Array.isArray(data.evidence) || !data.evidence.length || !data.evidence.every((item) => { try { const ref = object(item); return Object.keys(ref).sort().join(",") === "type,value" && ["event", "opaque"].includes(String(ref.type)) && typeof ref.value === "string" && ref.value.length > 0; } catch { return false; } })) throw new Error("Invalid economic action evidence."); }
}

export function validateGameRecordEvent(event: Event) { if (event.kind === GAME_ROOT_KIND) validateRoot(event); else validateAction(event); }
export function gameEscrowTag(escrowId: string) { if (!UUID.test(escrowId)) throw new Error("Invalid game escrow ID."); return `rollpot-escrow:${escrowId.toLowerCase()}`; }
export function winnerForMode(mode: GameMode, target: number | undefined, a: number, b: number): GameWinner | null {
  if (mode === GameMode.HigherRollWins) return a === b ? null : a > b ? GameWinner.Creator : GameWinner.Counterparty;
  if (mode === GameMode.LowerRollWins) return a === b ? null : a < b ? GameWinner.Creator : GameWinner.Counterparty;
  const ah = a === target; const bh = b === target; return ah === bh ? null : ah ? GameWinner.Creator : GameWinner.Counterparty;
}

export function createGameRecordRoot(input: GameRecordRoot, createdAt: number): EventTemplate {
  if (!HEX64.test(input.counterparty_pubkey) || !HEX64.test(input.escrow_authority_pubkey) || !HEX64.test(input.descriptor_event_id) || !/^30361:[0-9a-f]{64}:[^:]+$/.test(input.descriptor_address)) throw new Error("Invalid game authorities or descriptor.");
  const terms = { escrow_id: input.escrow_id, service_id: input.service_id, amount_sats: String(input.amount_sats), funding_model: "2_of_2", payout_network: "lightning", game_mode: input.game_mode, ...(input.target === undefined ? {} : { target: input.target }), fund_by: input.fund_by, result_by: input.result_by, recover_by: input.recover_by };
  return { kind: GAME_ROOT_KIND, created_at: createdAt, tags: [["p", "__SIGNER__", "", "game/player1"], ["p", input.counterparty_pubkey, "", "game/player2"], ["p", input.escrow_authority_pubkey, "", "core/escrow"], ["e", input.descriptor_event_id, "", "escrow-version"], ["a", input.descriptor_address, "", "escrow"], ["t", GAME_PROFILE], ["t", gameEscrowTag(input.escrow_id)]], content: JSON.stringify({ version: GAME_RECORD_VERSION, profile: GAME_PROFILE, terms, expires_at: input.expires_at }) };
}
export function bindRootProposer(template: EventTemplate, pubkey: string): EventTemplate { if (!HEX64.test(pubkey)) throw new Error("Invalid root proposer."); return { ...template, tags: template.tags.map((tag) => tag[0] === "p" && tag[1] === "__SIGNER__" ? ["p", pubkey, "", "game/player1"] : tag) }; }
export function createGameRecordAction(root: Event, action: Exclude<GameRecordAction, GameRecordAction.Root>, data: Record<string, unknown> = {}, createdAt: number, predecessor?: Event): EventTemplate {
  validateRoot(root); const previous = predecessor || root; if (previous.id !== root.id) { validateAction(previous); if (refs(previous).root !== root.id) throw new Error("Predecessor belongs to another game."); }
  return { kind: GAME_ACTION_KIND, created_at: createdAt, tags: [["e", root.id, "", "root"], ["e", previous.id, "", "prev"]], content: JSON.stringify({ version: GAME_RECORD_VERSION, action, ...(Object.keys(data).length ? { data } : {}) }) };
}

export function replayGameRecord(events: Event[], expected: { escrow_id: string; service_id: string; amount_sats: number; player1: string; player2: string; game_mode?: GameMode; target?: number; escrow_authority?: string; descriptor_event_id?: string; descriptor_address?: string }): GameRecord | null {
  const unique = [...new Map(events.map((event) => [event.id, event])).values()];
  const roots = unique.filter((event) => { try { validateRoot(event); return rootTerms(event).escrow_id === expected.escrow_id; } catch { return false; } });
  if (!roots.length) return null; if (roots.length !== 1) throw new Error("Conflicting game roots; coordination is frozen.");
  const root = roots[0]; const terms = rootTerms(root);
  if (root.pubkey !== expected.player1 || terms.counterparty_pubkey !== expected.player2 || terms.service_id !== expected.service_id || terms.amount_sats !== expected.amount_sats || (expected.game_mode !== undefined && (terms.game_mode !== expected.game_mode || terms.target !== expected.target)) || (expected.escrow_authority && terms.escrow_authority_pubkey !== expected.escrow_authority) || (expected.descriptor_event_id && terms.descriptor_event_id !== expected.descriptor_event_id) || (expected.descriptor_address && terms.descriptor_address !== expected.descriptor_address)) throw new Error("Published game root does not match this escrow, profile, or its authorities.");
  const candidates = unique.filter((event) => { try { validateAction(event); return refs(event).root === root.id; } catch { return false; } });
  const byPrev = new Map<string, Event[]>(); for (const event of candidates) { const prev = refs(event).prev; byPrev.set(prev, [...(byPrev.get(prev) || []), event]); }
  const actions: Event[] = []; let tip = root.id; while (byPrev.has(tip)) { const next = byPrev.get(tip)!; if (next.length !== 1) throw new Error("Forked game coordination; progression is frozen."); actions.push(next[0]); tip = next[0].id; }
  const accepted = new Set<string>(); const rolls = new Map<number, GameRound>(); let secured = false; let pendingResult: GameRoundResult | undefined; let result: GameRecord["result"]; let settlementAuthorization: Event | undefined; let settlement: Event | undefined; let refundAuthorization: Event | undefined; let refund: Event | undefined; let cancellation: Event | undefined; let expiration: Event | undefined; let currentRound = 1;
  for (const event of actions) {
    const value = content(event); const action = value.action as GameRecordAction; const data = (value.data || {}) as Record<string, unknown>;
    if (settlement || refund || cancellation || expiration) throw new Error("No action is allowed after a terminal outcome.");
    if (action === GameRecordAction.Accept) { if (secured || ![root.pubkey, terms.counterparty_pubkey].includes(event.pubkey) || accepted.has(event.pubkey)) throw new Error("Invalid or duplicate game acceptance."); accepted.add(event.pubkey); }
    else if (action === GameRecordAction.Secure) { if (event.pubkey !== terms.escrow_authority_pubkey || accepted.size !== 2 || secured) throw new Error("Invalid core/secure authority or funding gate."); secured = true; }
    else if (action === GameRecordAction.Roll) { if (!secured || pendingResult || result || ![root.pubkey, terms.counterparty_pubkey].includes(event.pubkey)) throw new Error("Invalid game roll authority or security gate."); const round = Number(data.round); if (round !== currentRound) throw new Error("Game roll rounds must be consecutive."); const pair = rolls.get(round) || {}; const role = event.pubkey === root.pubkey ? "creator" : "counterparty"; if (pair[role] || role === "counterparty" && !pair.creator || role === "creator" && pair.counterparty) throw new Error("Players must roll once in order each round."); pair[role] = { event, round, value: Number(data.value) }; rolls.set(round, pair); if (pair.creator && pair.counterparty) { const winner = winnerForMode(terms.game_mode, terms.target, pair.creator.value, pair.counterparty.value); if (winner) pendingResult = { round, creator_roll: pair.creator.value, counterparty_roll: pair.counterparty.value, winner }; else currentRound += 1; } }
    else if (action === GameRecordAction.Result) { if (!pendingResult || result || event.pubkey !== root.pubkey || data.round !== pendingResult.round || data.creator_roll !== pendingResult.creator_roll || data.counterparty_roll !== pendingResult.counterparty_roll || data.winner !== pendingResult.winner) throw new Error("Game result does not match both signed rolls."); result = { ...pendingResult, event }; }
    else if (action === GameRecordAction.AuthorizeSettlement) { const evidence = (data.evidence as Array<{ type: string; value: string }>)[0]; if (!result || settlementAuthorization || event.pubkey !== root.pubkey || evidence.type !== "event" || evidence.value !== result.event.id) throw new Error("Invalid settlement authorization."); settlementAuthorization = event; }
    else if (action === GameRecordAction.Settle) { if (!settlementAuthorization || event.pubkey !== terms.escrow_authority_pubkey) throw new Error("Invalid core/settle authority or sequence."); settlement = event; }
    else if (action === GameRecordAction.AuthorizeRefund) { if (refundAuthorization || event.created_at < terms.recover_by || ![root.pubkey, terms.counterparty_pubkey].includes(event.pubkey)) throw new Error("Invalid refund authorization."); refundAuthorization = event; }
    else if (action === GameRecordAction.Refund) { if (!refundAuthorization || event.pubkey !== terms.escrow_authority_pubkey) throw new Error("Invalid core/refund authority or sequence."); refund = event; }
    else if (action === GameRecordAction.Cancel) { if (event.pubkey !== root.pubkey || accepted.size || secured) throw new Error("Only the proposer may cancel an unaccepted game."); cancellation = event; }
    else if (action === GameRecordAction.Expire) { if (event.created_at < terms.expires_at || accepted.size || secured || ![root.pubkey, terms.counterparty_pubkey].includes(event.pubkey)) throw new Error("Only a player may expire an unaccepted game after its deadline."); expiration = event; }
  }
  const phase = settlement ? GameRecordPhase.Settled : refund ? GameRecordPhase.Refunded : cancellation ? GameRecordPhase.Cancelled : expiration ? GameRecordPhase.Expired : refundAuthorization ? GameRecordPhase.RefundAuthorized : settlementAuthorization ? GameRecordPhase.SettlementAuthorized : result ? GameRecordPhase.Result : rolls.size ? GameRecordPhase.Rolling : secured ? GameRecordPhase.Secured : accepted.size ? GameRecordPhase.Funding : GameRecordPhase.Proposed;
  return { root, version: GameRecordVersion.Current, mode: terms.game_mode, ...(terms.target === undefined ? {} : { target: terms.target }), terms, actions, accepted, secured, rolls, currentRound, phase, ...(pendingResult ? { pendingResult } : {}), ...(result ? { result } : {}), ...(settlementAuthorization ? { settlementAuthorization } : {}), ...(settlement ? { settlement } : {}), ...(refundAuthorization ? { refundAuthorization } : {}), ...(refund ? { refund } : {}), ...(cancellation ? { cancellation } : {}), ...(expiration ? { expiration } : {}) };
}
export function gameTip(game: GameRecord) { return game.actions.at(-1) || game.root; }
