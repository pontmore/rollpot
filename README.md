# Rollpot

Standalone Next.js client that validates Pontmore escrow service invocation with a two-player dice wager.

The client discovers signed PIP-01 escrow descriptors (Nostr kind `30361`) from public relays,
validates each advertised HTTP endpoint and OpenAPI schema, signs NIP-98 HTTP auth events locally,
and submits an `application_signed_result` release decision after a dice roll. A direct HTTPS
descriptor URL can also be validated as a fallback.

Only standalone descriptors compatible with Rollpot are selectable: HTTPS transport,
`pontmore_escrow_http_v1`, NIP-98 authentication, the canonical operation set, `2_of_2`
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

Set `NOSTR_PROFILE_RELAYS` to override the public relays used to read and publish Nostr player profiles.

## Docker

```bash
docker build -t pontmore/rollpot .
docker run --rm -p 3002:3002 pontmore/rollpot
```

## Flow

1. Open `/escrows` to discover compatible descriptors or validate a direct descriptor URL, then select a service.
2. On `/`, complete the player profile, optionally select **Save to Nostr** to publish its name and Lightning address, then create or join a game.
3. Open the game's `/games/[id]` page to copy its enrollment invite, request each player's Lightning invoice, and roll. The home page shows the three newest games; `/games` lists all browser-saved games.
4. The Rollpot backend polls the escrow service for enrollment and funding status and streams changes to each player's game page.
5. Request release with a BIP-340 application signature over the canonical release message.

The game page keeps the Escrow state card collapsed until the player requests its technical details.
Roll becomes available only when the escrow reports its `2_of_2` funding threshold reached.
The funding deadline remains in technical details while funding is incomplete. New invites carry
the creator's service deadline for joiners because the service join response omits it; the joiner's
copy is labeled as invite-supplied.

Selecting another escrow changes the service for new games. Existing games remain bound to the
escrow that created their ID, enrollment tokens, invoices, and funds; their dedicated pages restore
that service from the browser's saved-game record.
