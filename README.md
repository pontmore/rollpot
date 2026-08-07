# Rollpot

Standalone Next.js client that validates Pontmore escrow service invocation with a two-player dice wager.

The client discovers signed PIP-01 escrow descriptors (Nostr kind `30361`) from public relays,
validates each advertised HTTP endpoint and OpenAPI schema, signs NIP-98 HTTP auth events locally,
and submits an `application_signed_result` release decision after a dice roll. A direct HTTPS
descriptor URL can also be validated as a fallback.

Only standalone descriptors compatible with Rollpot are selectable: HTTPS transport,
`pontmore_escrow_http_v1`, NIP-98 authentication, the canonical operation set, `two_party`
funding, and `application_signed_result` releases.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3002`.

Set `ESCROW_DISCOVERY_RELAYS` to a comma-separated relay list to override the defaults:

```bash
ESCROW_DISCOVERY_RELAYS=wss://relay.example.com,wss://relay2.example.com npm run dev
```

## Docker

```bash
docker build -t pontmore/rollpot .
docker run --rm -p 3002:3002 pontmore/rollpot
```

## Flow

1. Discover compatible descriptors from Nostr relays or validate a direct descriptor URL.
2. Select an escrow before creating a game.
3. Create a `two_party` escrow through the descriptor service endpoint.
4. Join the counterparty with the service-issued enrollment token.
5. Request per-participant Lightning funding instructions.
6. Poll each participant's funding status.
7. Roll dice and request release with a BIP-340 application signature over the canonical release message.

Selecting another escrow starts a new game. Existing games remain bound to the escrow that created
their ID, enrollment tokens, invoices, and funds. Opening a saved game automatically switches back
to that game's original escrow.
