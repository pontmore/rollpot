import "server-only";

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
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
  const schemaUrl = await assertStandaloneService(validatedDescriptor);
  const schema = await fetchJson(schemaUrl, SCHEMA_LIMIT, "schema");
  const { operationUrls, enrollment, fundingModels, releaseDecisions, endpoint } = validateOpenApiSchema(schema);

  return {
    source,
    service_id: source.type === "url" ? source.url : `${source.event.pubkey}:${getEventIdentifier(source.event)}`,
    descriptor: validatedDescriptor,
    endpoint,
    schema_url: schemaUrl,
    operation_urls: operationUrls,
    enrollment,
    funding_models: fundingModels,
    release_decisions: releaseDecisions,
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
    cache: label === "schema" ? "force-cache" : "no-store",
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
  if (!isRecord(value.funding_rules) || !isRecord(value.dispute_rules)) {
    throw new Error("Descriptor funding and dispute rules are required.");
  }
  if (!isStringArray(value.networks) || value.networks.length === 0) throw new Error("Descriptor networks must be non-empty.");
}

async function assertStandaloneService(value: EscrowDescriptor): Promise<string> {
  if (!isRecord(value.service) || !isRecord(value.service.schema)) {
    throw new Error("Descriptor is discovery-only and cannot be used standalone.");
  }
  const schema = value.service.schema;
  if (schema.type && schema.type !== "openapi") {
    throw new Error(`Unsupported service schema type: ${String(schema.type)}.`);
  }
  requireString(schema, "url", "Service schema");
  const schemaUrl = await validatePublicHttpsUrl(schema.url, "Schema URL");
  assertVersionedSchemaUrl(schemaUrl);
  return schemaUrl;
}

function validateOpenApiSchema(value: unknown): {
  operationUrls: EscrowService["operation_urls"];
  enrollment: EscrowService["enrollment"];
  fundingModels: string[];
  releaseDecisions: string[];
  endpoint: string;
} {
  if (!isRecord(value) || typeof value.openapi !== "string" || !isRecord(value.paths)) {
    throw new Error("Schema must be an OpenAPI JSON document.");
  }

  const serverUrl = Array.isArray(value.servers) && isRecord(value.servers[0]) ? value.servers[0].url : "";
  if (typeof serverUrl !== "string" || !serverUrl.trim()) {
    throw new Error("Schema does not define an HTTPS server URL.");
  }
  const endpoint = normalizeUrlString(serverUrl);
  if (!endpoint || !endpoint.startsWith("https://")) {
    throw new Error("Schema server URL must be a public HTTPS URL.");
  }

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

  const fundingModelSpec = value["x-pontmore-funding-model"] as Record<string, any>;
  const modelMap = isRecord(fundingModelSpec.models) ? fundingModelSpec.models : fundingModelSpec;
  const fundingModels = Object.keys(modelMap).filter((key) => key !== "description");
  if (!fundingModels.includes("2_of_2")) {
    throw new Error("Rollpot requires the 2_of_2 funding model.");
  }

  const releaseDecisionSpec = value["x-pontmore-release-decisions"] as Record<string, any>;
  const releaseDecisions = isRecord(releaseDecisionSpec.formats) ? Object.keys(releaseDecisionSpec.formats) : [];
  if (!releaseDecisions.includes("application_signed_result")) {
    throw new Error("Rollpot requires application_signed_result releases.");
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

  return { operationUrls, enrollment, fundingModels, releaseDecisions, endpoint };
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

  // Node fetch uses the system resolver. Check that same set of addresses,
  // avoiding a separate AAAA query that can stall for several seconds.
  const addresses = isIP(hostname)
    ? [hostname]
    : (await lookup(hostname, { all: true }).catch(() => [])).map(({ address }) => address);
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

function requireString<T extends Record<string, any>>(value: T, field: keyof T, label: string): asserts value is T & Record<typeof field, string> {
  if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`${label} ${String(field)} is required.`);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
