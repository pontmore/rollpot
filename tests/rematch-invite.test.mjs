import assert from "node:assert/strict";
import test from "node:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { decryptInvite, encryptInvite } from "../lib/crypto.ts";

test("a rematch enrollment token is encrypted for only the invited player", async () => {
  const senderSecret = generateSecretKey();
  const recipientSecret = generateSecretKey();
  const strangerSecret = generateSecretKey();
  const sender = { pubkey: getPublicKey(senderSecret), secretKey: senderSecret };
  const recipient = { pubkey: getPublicKey(recipientSecret), secretKey: recipientSecret };
  const stranger = { pubkey: getPublicKey(strangerSecret), secretKey: strangerSecret };
  const invite = JSON.stringify({ enrollment_token: "private-token-123", escrow_id: "rematch-1" });
  const ciphertext = await encryptInvite(sender, recipient.pubkey, invite);
  assert.equal(ciphertext.includes("private-token-123"), false);
  assert.equal(await decryptInvite(recipient, sender.pubkey, ciphertext), invite);
  await assert.rejects(() => decryptInvite(stranger, sender.pubkey, ciphertext));
});
