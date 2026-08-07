export const DESCRIPTOR_URL = "https://standalone-escrow.onrender.com/pontmore/v1/descriptor";

export const REQUIRED_OPERATIONS = ["create", "funding_instructions", "fund_status", "release", "refund", "cancel"] as const;

export type EscrowDescriptorSource =
  | { type: "url"; url: string }
  | { type: "nostr"; event: NostrEvent };

export type EscrowDescriptor = {
  version: number;
  escrow_type: string;
  networks: string[];
  funding_rules: {
    required_confirmation: string;
  };
  release_rules: {
    release_trigger: string;
    refund_trigger: string;
  };
  dispute_rules: {
    policy: string;
  };
  reference_format: string;
  updated_at: number;
  service?: {
    transport?: string[];
    interface?: string;
    endpoint?: string;
    schema_url?: string;
    auth?: string[];
    operations?: string[];
    funding_model?: string[];
    funding_threshold?: number;
    participant_count?: number;
    release_decisions?: string[];
    default_funding_model?: string;
    decision_signers?: {
      operator_pubkey?: string;
      application_pubkeys?: string[];
      oracle_pubkeys?: string[];
    };
  };
};

export type EscrowService = {
  source: EscrowDescriptorSource;
  service_id: string;
  descriptor: EscrowDescriptor;
  endpoint: string;
  schema_url: string;
  operation_urls: Record<(typeof REQUIRED_OPERATIONS)[number], string>;
  enrollment: "open_token" | "predeclared_pubkey";
};

export type EscrowIdentity = {
  label: string;
  pubkey: string;
  npub: string;
  secretKey?: Uint8Array;
  signEvent?: (event: Omit<NostrEvent, "id" | "sig">) => Promise<NostrEvent>;
};

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type PlayerProfile = {
  name: string;
  npub: string;
  pubkey: string;
  lightning_address: string;
};

export type CreateEscrowResponse = {
  escrow_id: string;
  state: string;
  creator_pubkey: string;
  counterparty_pubkey?: string | null;
  amount_sats: number;
  platform_fee_sats?: number;
  funding_model: string;
  funding_threshold?: number | null;
  participant_count?: number | null;
  funding_deadline?: string;
  enrollments?: Array<{
    participant_pubkey?: string;
    enrollment_token: string;
  }>;
};

export type FundingInstructionsResponse = {
  escrow_id: string;
  funder_pubkey?: string | null;
  payment_hash: string;
  payment_request: string;
  amount_sats: number;
  funding_model: string;
};

export type FundStatusResponse = {
  escrow_id: string;
  state: string;
  funded: boolean;
  funding_model: string;
  invoice_status?: string | null;
  funded_count?: number | null;
  total_funders?: number | null;
  funding_threshold?: number | null;
  my_funded?: boolean | null;
  funder_status?: string | null;
};

export type ReleaseEscrowResponse = {
  escrow_id: string;
  state: "released";
  recipient: "creator" | "counterparty";
  payout_sats: number;
  payout: unknown;
};

export type DiceGameResult = {
  escrow_id: string;
  creator_roll: number;
  counterparty_roll: number;
  winner: "creator" | "counterparty";
  winner_name: string;
  settlement_address: string;
  rolled_at: string;
};

export type TrackedDiceGame = {
  id: string;
  created_at: string;
  updated_at: string;
  amount_sats: number;
  funding_model: string;
  refund_ln_address: string;
  local_role: "creator" | "counterparty";
  creator_player: PlayerProfile;
  counterparty_player: PlayerProfile | null;
  escrow: CreateEscrowResponse;
  creator_funding: FundingInstructionsResponse | null;
  counterparty_funding: FundingInstructionsResponse | null;
  creator_status: FundStatusResponse | null;
  counterparty_status: FundStatusResponse | null;
  result: DiceGameResult | null;
  release: ReleaseEscrowResponse | null;
  service: EscrowService;
};

export type GameInvite = {
  version: 1;
  game: "rollpot";
  escrow_id: string;
  enrollment_token: string;
  counterparty_pubkey?: string;
  amount_sats: number;
  funding_model: string;
  creator_player: PlayerProfile;
  created_at: string;
  service_source: EscrowDescriptorSource;
};

export type EscrowCatalogEntry = {
  service?: EscrowService;
  descriptor?: Partial<EscrowDescriptor>;
  source: EscrowDescriptorSource;
  publisher_pubkey: string;
  identifier: string;
  compatible: boolean;
  compatibility_status: "discovery_only" | "standalone_compatible" | "standalone_incompatible";
  compatibility_reason?: string;
};
