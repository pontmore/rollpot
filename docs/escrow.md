# Pontmore escrow integration

Rollpot discovers general-purpose Pontmore escrow services, uses their HTTP APIs to hold and move the pot, and wraps their observable lifecycle in the [`rollpot/game@1`](./game.md) PIP-02 profile. Escrows do not need Rollpot-specific endpoints.

## Discovery

Rollpot reads signed [PIP-01 escrow descriptors](https://github.com/pontmore/protocol/blob/main/PIP-01-escrow-descriptor.md) from Nostr kind `30361` events. It validates the descriptor, fetches its advertised OpenAPI schema, and accepts a service only when it supports:

- HTTPS transport and `pontmore_escrow_http_v1`
- NIP-98 request authentication
- participant enrollment and `2_of_2` funding
- create, funding instructions, funding status, release, refund, and cancel operations
- `application_signed_result` release decisions

The descriptor advertises a service; it is neither an escrow instance nor proof that funds moved. Every game root pins the exact signed revision and its address. Rollpot selects escrows only through signed PIP-01 events because a URL alone cannot satisfy the PIP-02 descriptor binding.

## HTTP lifecycle

1. Player 1 creates a two-player escrow and shares its enrollment invite.
2. Player 2 joins with a Nostr identity and payout or refund address.
3. Each player requests and pays their own Lightning invoice.
4. Each client uses fresh NIP-98 authorization to read its funding status. A confirmed personal payment permits that player to publish `core/accept`.
5. After both payments and acceptances, the Rollpot server reads the escrow status and publishes `core/secure` with its bound adapter key.
6. After both players roll and Player 1 authorizes the derived result, the server submits its signed application result to the release operation.
7. The server publishes `core/settle` only after the service confirms the correct recipient and completed payout. Recovery similarly ends in `core/refund` only after completed refunds.

Invoices, enrollment tokens, NIP-98 events, Lightning addresses, and payout details remain outside the public coordination chain. A rematch invite is encrypted to its known recipient with NIP-44.

## Authority boundary

`ROLLPOT_SERVER_NSEC` gives the deployed application a stable identity. The `rollpot/game@1` profile binds that identity as a `core/escrow` adapter because current services do not sign PIP-02 actions themselves. Its kernel events attest to authenticated observations:

- `core/secure`: the service reported both required stakes
- `core/settle`: release selected the recorded winner and its payout completed
- `core/refund`: all reported refund payouts completed

The adapter cannot manufacture custody evidence. Current services expose status responses rather than signed funding receipts, and a pending or ambiguous Lightning payment must be reconciled before the adapter records a terminal action.

The escrow's release verifier currently validates an application signature without requiring the key pinned by the game. PIP-02 therefore makes the public lifecycle auditable but does not, by itself, stop a participant from bypassing Rollpot and submitting another validly signed result. The escrow must bind the allowed application signer or verify the game result to enforce the same authority at the money-moving boundary. See [mk-Denver/pontmore-lightning-escrow#12](https://github.com/mk-Denver/pontmore-lightning-escrow/issues/12).
