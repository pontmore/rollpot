# Rollpot game coordination (`rollpot/game@1`)

Rollpot implements its game lifecycle as a [PIP-02 coordination event chain](https://github.com/pontmore/protocol/blob/main/PIP-02-coordination-event-chains.md). A signed root event (kind `7300`) fixes the players, rule, stake, escrow service, Rollpot authority, and deadlines. Signed action events (kind `7301`) form one linear history from funding acceptance through rolls and the final economic outcome.

The Pontmore escrow remains the source of truth for custody and payments. The Rollpot server is the profile's bound `core/escrow` adapter: it observes authenticated escrow responses and signs the PIP-02 kernel actions that correspond to those responses. The adapter does not hold the money and does not turn an HTTP response into a cryptographic receipt from the escrow service.

## Creating the root

An invite may be created before Player 2 is known. It is an escrow enrollment credential, not the game root. Rollpot creates the root only after the escrow identifies both Nostr pubkeys. A rematch can skip manual code sharing because the new invite is encrypted to the already-known partner and delivered over Nostr.

The root has content version `2` and `profile: "rollpot/game@1"`. Its role tags bind:

- `game/player1`: the creator and root signer
- `game/player2`: the joined player
- `core/escrow`: the stable Rollpot server key acting as the profile adapter

There is no referee role.

The root pins both the exact signed PIP-01 descriptor event with an `escrow-version` event tag and its kind `30361` address with an `escrow` address tag. Rollpot selects descriptors from Nostr by coordinate. The descriptor must predate the root and remain unexpired when each player accepts.

The root terms are:

| Field | Value |
| --- | --- |
| `escrow_id` | The escrow instance UUID |
| `service_id` | The selected PIP-01 service identifier |
| `amount_sats` | Each player's positive stake, encoded as a decimal string |
| `funding_model` | `2_of_2` |
| `payout_network` | `lightning` |
| `game_mode` | `higher_roll_wins`, `lower_roll_wins`, or `roll_to_target` |
| `target` | Die face 1 through 6, present only for `roll_to_target` |
| `fund_by` | Last funding time |
| `result_by` | Last ordinary play time |
| `recover_by` | Earliest profile recovery time |

Root `expires_at` is earlier than `fund_by`, followed by `result_by` and `recover_by`. Invoices, enrollment tokens, payment hashes, payout addresses, and NIP-98 authorizations never appear in the public chain.

## Actions and derived state

The first action references the root as both `root` and `prev`. Every later action references the same root and the current action tip. Rollpot validates signatures, roles, content, the pinned descriptor, and the predecessor link before deriving state. Two otherwise valid actions with the same predecessor freeze the game as a fork; relay order, timestamps, and event IDs do not choose a branch.

| Action | Signer | Profile rule |
| --- | --- | --- |
| `core/accept` | Each player | Published automatically after that player's authenticated funding status confirms payment. |
| `core/secure` | Rollpot adapter | Published only after both acceptances and an authenticated escrow status confirms the `2_of_2` threshold. |
| `game/roll` | The rolling player | One value from 1 through 6. Player 1 rolls first and Player 2 follows in each round. |
| `game/result` | Player 1 | Must reproduce both signed rolls and the winner derived from the root rule. |
| `core/authorize_settlement` | Player 1 | References the result event and authorizes its winner for payout. |
| `core/settle` | Rollpot adapter | Published only after the escrow confirms the same recipient and a completed payout. |
| `core/authorize_refund` | Either player | Allowed at or after `recover_by`; it authorizes recovery when settlement has not completed. |
| `core/refund` | Rollpot adapter | Published only after the escrow confirms completed refunds. |
| `core/cancel` | Player 1 | Ends an unaccepted game before funds are secured. |
| `core/expire` | Either player | Ends an unaccepted game after `expires_at`. |

Each player funding the escrow is their acceptance of the game, but `core/accept` is still a player claim. Current escrows do not provide verifiable funding receipts. `core/secure` means the Rollpot adapter observed the service report both stakes; it does not claim the underlying service signed that fact.

For `higher_roll_wins` and `lower_roll_wins`, an equal pair starts another round. For `roll_to_target`, exactly one player hitting the target wins; both hitting or neither hitting starts another round. Every roll remains in the chain, so clients can render all previous rounds. Browser-generated rolls are signed claims and are not publicly verifiable randomness.

The result does not move funds. After the result and settlement authorization are present, the server signs the escrow's application result and calls its release operation. It records `core/settle` only when the response identifies the chain winner and reports a completed payout. A response such as `pending_bolt11` leaves the chain settlement-authorized until the service can prove or reconcile the final outcome. Refunds follow the same rule.

## Rollpot adapter

The adapter key comes from `ROLLPOT_SERVER_NSEC` and its public key is placed in every new root. Both players accept that key as the `rollpot/game@1` economic observer. The server replays the submitted chain, checks its own binding, rediscovers the pinned service, validates a fresh player NIP-98 authorization, and reads `fund_status` before signing `core/secure`. Settlement and refund additionally require fresh authorization for the corresponding escrow operation.

This makes a complete, verifiable PIP-02 chain of what the players and Rollpot adapter asserted. It does not make the naive HTTP escrow aware of PIP-02. The current escrow also accepts an application result signed by any valid key, so it does not yet enforce the adapter key that the players pinned. A player who bypasses Rollpot could attempt a conflicting release directly. The escrow should bind the permitted application signer or verify the PIP-02 result before moving funds; this integration gap is tracked in [mk-Denver/pontmore-lightning-escrow#12](https://github.com/mk-Denver/pontmore-lightning-escrow/issues/12).

## Persistence and sharing

New game state is persisted in PIP-02 kinds `7300` and `7301` on the configured Nostr relays. Browser storage keeps the private HTTP material needed to operate the escrow and a local index of games; it is not the authoritative shared game history. The client periodically reloads and replays relay events, and the publication endpoint rejects a stale predecessor when it can observe a newer tip.

Rematch delivery still uses a separate, NIP-44-encrypted Nostr invite. That ciphertext carries a private enrollment credential and is not game state. New games do not use NIP-78 records to share roots, acceptances, rolls, results, or economic outcomes.
