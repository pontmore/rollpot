import assert from "node:assert/strict";
import test from "node:test";
import { hasReachedFundingThreshold, isEscrowTerminal, isOwnPaymentConfirmed } from "../lib/escrow.ts";

const twoPartyStatus = {
  escrow_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  funding_model: "2_of_2",
  funding_threshold: 2,
};

test("one paid participant does not enable rolling", () => {
  const status = { ...twoPartyStatus, state: "partially_funded", funded: true, my_funded: true, funded_count: 1 };
  assert.equal(hasReachedFundingThreshold(status), false);
});

test("both paid participants enable rolling only while the escrow is active", () => {
  assert.equal(hasReachedFundingThreshold({ ...twoPartyStatus, state: "active", funded: true, funded_count: 2 }), true);
  assert.equal(hasReachedFundingThreshold({ ...twoPartyStatus, state: "active", funded: true, funded_count: 1 }), false);
  const released = { ...twoPartyStatus, state: "released", funded: true, funded_count: 2 };
  assert.equal(hasReachedFundingThreshold(released), false);
  assert.equal(isEscrowTerminal(released), true);
});

test("a funder's own payment field takes priority over the escrow aggregate", () => {
  assert.equal(isOwnPaymentConfirmed({ ...twoPartyStatus, funded: true, my_funded: false }), false);
  assert.equal(isOwnPaymentConfirmed({ ...twoPartyStatus, funded: false, my_funded: true }), true);
});
