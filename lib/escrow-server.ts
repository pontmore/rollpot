import "server-only";

import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import {
  REQUIRED_OPERATIONS,
  type EscrowDescriptorSource,
  type EscrowDescriptor,
  type EscrowService,
  type NostrEvent,
} from "./escrow";

const DESCRIPTOR_LIMIT = 256 * 1024;
const SCHEMA_LIMIT = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export async function discoverEscrowService(descriptorUrl: string): Promise<EscrowService> {
  const normalizedDescriptorUrl = await validatePublicHttpsUrl(descriptorUrl, "Descriptor URL");
  const descriptor = await fetchJson(normalizedDescriptorUrl, DESCRIPTOR_LIMIT, "descriptor");
  return validateEscrowService(descriptor, { type: "url", url: normalizedDescriptorUrl });
}

export async function validateEscrowService(descriptor: unknown, source: EscrowDescriptorSource): Promise<EscrowService> {
  const validatedDescriptor = validateEscrowDescriptor(descriptor);

  assertStandaloneService(validatedDescriptor);
  const service = validatedDescriptor.service!;
  const endpoint = await validatePublicHttpsUrl(service.endpoint!, "Service endpoint");
  const schemaUrl = await validatePublicHttpsUrl(service.schema_url!, "Schema URL");
  assertVersionedSchemaUrl(schemaUrl);
  const schema = await fetchJson(schemaUrl, SCHEMA_LIMIT, "schema");
  const { operationUrls, enrollment } = validateOpenApiSchema(schema, endpoint);

  return {
    source,
    service_id: source.type === "url" ? source.url : `${source.event.pubkey}:${getEventIdentifier(source.event)}`,
    descriptor: validatedDescriptor,
    endpoint,
    schema_url: schemaUrl,
    operation_urls: operationUrls,
    enrollment,
  };
}

export function validateEscrowDescriptor(value: unknown): EscrowDescriptor {
  assertDescriptor(value);
  return value;
}

function getEventIdentifier(event: NostrEvent) {
  return event.tags.find(([name]) => name === "d")?.[1] || event.id;
}

async function fetchJson(url: string, maxBytes: number, label: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`${capitalize(label)} fetch failed with ${response.status}.`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    throw new Error(`${capitalize(label)} must use a JSON content type.`);
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    throw new Error(`${capitalize(label)} exceeds the ${maxBytes}-byte limit.`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${capitalize(label)} response is empty.`);

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`${capitalize(label)} exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error(`${capitalize(label)} is not valid JSON.`);
  }
}

function assertDescriptor(value: unknown): asserts value is EscrowDescriptor {
  if (!isRecord(value)) throw new Error("Descriptor must be a JSON object.");
  if (value.version !== 1) throw new Error("Rollpot supports PIP-01 descriptor version 1 only.");
  requireString(value, "escrow_type", "Descriptor");
  requireString(value, "reference_format", "Descriptor");
  if (typeof value.updated_at !== "number") throw new Error("Descriptor updated_at is required.");
  if (!isStringArray(value.networks) || value.networks.length === 0) throw new Error("Descriptor networks must be non-empty.");
  if (!isRecord(value.funding_rules) || !isRecord(value.release_rules) || !isRecord(value.dispute_rules)) {
    throw new Error("Descriptor funding, release, and dispute rules are required.");
  }
}

function assertStandaloneService(value: EscrowDescriptor): asserts value is EscrowDescriptor & { service: NonNullable<EscrowDescriptor["service"]> } {
  if (!isRecord(value.service)) throw new Error("Descriptor is discovery-only and cannot be used standalone.");
  const service = value.service;
  if (!isStringArray(service.transport) || service.transport[0] !== "https") {
    throw new Error("Rollpot requires HTTPS as the canonical service transport.");
  }
  if (service.interface !== "pontmore_escrow_http_v1") {
    throw new Error(`Unsupported escrow interface: ${String(service.interface || "missing")}.`);
  }
  requireString(service, "endpoint", "Service");
  requireString(service, "schema_url", "Service");
  if (!isStringArray(service.auth) || !service.auth.includes("nostr_http_auth")) {
    throw new Error("Rollpot requires nostr_http_auth.");
  }
  if (!isStringArray(service.operations) || REQUIRED_OPERATIONS.some((operation) => !service.operations!.includes(operation))) {
    throw new Error("Service does not advertise every required standalone escrow operation.");
  }
  if (!isStringArray(service.funding_model) || !service.funding_model.includes("two_party")) {
    throw new Error("Rollpot requires the two_party funding model.");
  }
  if (!isStringArray(service.release_decisions) || !service.release_decisions.includes("application_signed_result")) {
    throw new Error("Rollpot requires application_signed_result releases.");
  }
  if (service.operations.includes("split") && !service.release_decisions.includes("split_decision")) {
    throw new Error("A service advertising split must also advertise split_decision.");
  }
}

function validateOpenApiSchema(value: unknown, endpoint: string): {
  operationUrls: EscrowService["operation_urls"];
  enrollment: EscrowService["enrollment"];
} {
  if (!isRecord(value) || typeof value.openapi !== "string" || !isRecord(value.paths)) {
    throw new Error("Schema must be an OpenAPI JSON document.");
  }

  const serverMatches = Array.isArray(value.servers) && value.servers.some((server) => {
    return isRecord(server) && normalizeUrlString(server.url) === endpoint;
  });
  if (!serverMatches) throw new Error("Schema does not bind its server URL to the descriptor endpoint.");

  for (const extension of [
    "x-pontmore-state-machine",
    "x-pontmore-idempotency",
    "x-pontmore-funding-model",
    "x-pontmore-release-decisions",
    "x-pontmore-timeouts",
    "x-pontmore-schema-fetch",
  ]) {
    if (!isRecord(value[extension])) throw new Error(`Schema is missing ${extension}.`);
  }

  const schemas = isRecord(value.components) && isRecord(value.components.schemas) ? value.components.schemas : null;
  const createRequest = schemas && isRecord(schemas.CreateRequest) ? schemas.CreateRequest : null;
  const createProperties = createRequest && isRecord(createRequest.properties) ? createRequest.properties : null;
  if (!createProperties || !("enrollment_token" in createProperties)) {
    throw new Error("Schema does not define Rollpot-compatible participant enrollment.");
  }
  const enrollment = "participant_pubkeys" in createProperties ? "predeclared_pubkey" : "open_token";

  const operationUrls = {} as EscrowService["operation_urls"];
  for (const operation of REQUIRED_OPERATIONS) {
    const path = Object.entries(value.paths).find(([candidatePath, pathItem]) => {
      if (!candidatePath.startsWith("/") || !isRecord(pathItem) || !isRecord(pathItem.post)) return false;
      return pathItem.post.summary === operation || candidatePath === `/${operation}`;
    })?.[0];
    if (!path) throw new Error(`Schema does not define the ${operation} operation.`);
    const endpointUrl = new URL(endpoint);
    const endpointPath = endpointUrl.pathname.replace(/\/$/, "");
    const operationPath = path.startsWith(`${endpointPath}/`) ? path : `${endpointPath}${path}`;
    operationUrls[operation] = new URL(operationPath, endpointUrl.origin).toString();
  }

  return { operationUrls, enrollment };
}

async function validatePublicHttpsUrl(value: string, label: string): Promise<string> {
  if (!value || value.length > 2048) throw new Error(`${label} is required.`);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials.`);
  if (url.hash) throw new Error(`${label} must not contain a fragment.`);

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error(`${label} must use a public host.`);
  }

  const addresses = isIP(hostname)
    ? [hostname]
    : [...await resolve4(hostname).catch(() => []), ...await resolve6(hostname).catch(() => [])];
  if (addresses.length === 0 || addresses.some(isDisallowedAddress)) {
    throw new Error(`${label} resolves to a disallowed network address.`);
  }

  return normalizeUrlString(url.toString());
}

function isDisallowedAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped || (isIP(normalized) === 4 ? normalized : "");
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function normalizeUrlString(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function assertVersionedSchemaUrl(schemaUrl: string) {
  const pathname = new URL(schemaUrl).pathname.toLowerCase();
  if (!/(?:^|[/_.-])v?\d+\.\d+(?:\.\d+)?(?:[/_.-]|$)|[a-f0-9]{32,}/.test(pathname)) {
    throw new Error("Schema URL must identify an immutable or versioned artifact.");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function requireString(value: Record<string, any>, field: string, label: string) {
  if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`${label} ${field} is required.`);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
