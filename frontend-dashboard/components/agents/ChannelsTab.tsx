import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  MessagesSquare,
  Pencil,
  Power,
  QrCode,
  RefreshCw,
  Save,
  SearchCheck,
  Settings,
  X,
} from "lucide-react";
import MessageTimeline from "./MessageTimeline";
import InboundSecretDialog from "./InboundSecretDialog";
import {
  buildRotationBody,
  generateInboundSecret,
  revealFromCreateResponse,
  type SecretReveal,
} from "../../lib/inboundSecret";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../Toast";

const REDACTED_SECRET = "[REDACTED]";
const CHANNEL_GLYPHS: Record<string, string> = Object.freeze({
  bluebubbles: "💬",
  discord: "🎮",
  email: "📧",
  feishu: "飞",
  googlechat: "💭",
  imessage: "💬",
  irc: "IRC",
  line: "🟢",
  mattermost: "M",
  matrix: "⬡",
  msteams: "T",
  nextcloud: "☁️",
  "nextcloud-talk": "☁️",
  nostr: "⚡",
  qqbot: "QQ",
  signal: "🔒",
  slack: "💬",
  "synology-chat": "DS",
  telegram: "✈️",
  tlon: "◌",
  twitch: "📺",
  webhook: "🌐",
  whatsapp: "📱",
  yuanbao: "YB",
  zalo: "Z",
  zalouser: "Z",
});
const DEFAULT_PAYLOAD = Object.freeze({
  runtime: "legacy",
  title: "Channels",
  description: "",
  capabilities: {
    supportsTesting: true,
    supportsMessageHistory: true,
    supportsArbitraryNames: true,
    supportsLazyTypeDefinitions: false,
  },
  channels: [],
  availableTypes: [],
});

type FieldOption = {
  label: string;
  value: unknown;
};

type FieldDefinition = {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  requiredWhen?: {
    key?: string;
    value?: unknown;
    values?: unknown[];
  };
  placeholder?: string;
  help?: string;
  itemType?: string;
  defaultValue?: unknown;
  options?: FieldOption[];
};

type ChannelTypeDefinition = {
  id: string;
  type: string;
  label: string;
  title?: string;
  detailLabel?: string;
  description?: string;
  icon?: string | null;
  systemImage?: string | null;
  configFields: FieldDefinition[];
  hasComplexFields?: boolean;
  detailsLoaded?: boolean;
  actions?: {
    canQrLogin?: boolean;
    canLogout?: boolean;
    loginKind?: string | null;
  };
};

type ChannelAccount = {
  accountId: string;
  name?: string | null;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  healthState?: string | null;
  lastError?: string | null;
};

type ChannelRecord = {
  id: string;
  type: string;
  name: string;
  selectionLabel?: string;
  detailLabel?: string;
  icon?: string | null;
  systemImage?: string | null;
  configured?: boolean;
  enabled?: boolean;
  readOnly?: boolean;
  accountCount?: number;
  defaultAccountId?: string | null;
  accounts?: ChannelAccount[];
  config?: Record<string, any>;
  status?: {
    state?: string | null;
    connected?: boolean;
    running?: boolean;
    healthState?: string | null;
    lastError?: string | null;
    lastConnectedAt?: string | null;
    lastProbeAt?: string | null;
  };
  actions?: {
    canEdit?: boolean;
    canToggle?: boolean;
    canDelete?: boolean;
    canTest?: boolean;
    canViewMessages?: boolean;
    canQrLogin?: boolean;
    canLogout?: boolean;
    loginKind?: string | null;
  };
};

type ChannelsPayload = {
  runtime: string;
  title: string;
  description: string;
  capabilities: {
    supportsTesting: boolean;
    supportsMessageHistory: boolean;
    supportsArbitraryNames: boolean;
    supportsLazyTypeDefinitions: boolean;
  };
  channels: ChannelRecord[];
  availableTypes: ChannelTypeDefinition[];
};

type MessageRecord = {
  id: string | number;
  direction?: string;
  content?: string;
  created_at?: string;
  metadata?: {
    sender?: string;
  };
};

type FormValues = Record<string, string | boolean>;

type LoginModalState = {
  open: boolean;
  channel: ChannelRecord | null;
  qrDataUrl: string;
  qrText: string;
  status: string;
  error: string;
  starting: boolean;
  checking: boolean;
};

type CreatePairingState = Omit<LoginModalState, "open" | "channel"> & {
  channelType: string;
};

function createEmptyCreatePairingState(channelType = ""): CreatePairingState {
  return {
    channelType,
    qrDataUrl: "",
    qrText: "",
    status: "",
    error: "",
    starting: false,
    checking: false,
  };
}

function getTypeId(entry: { id?: string; type?: string } | null | undefined) {
  return String(entry?.type || entry?.id || "")
    .trim()
    .toLowerCase();
}

function prettifyStatus(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Unknown";
  return normalized.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function channelTone(state: string | null | undefined, enabled: boolean) {
  if (!enabled) return "bg-slate-100 text-slate-600";

  switch (
    String(state || "")
      .trim()
      .toLowerCase()
  ) {
    case "connected":
    case "running":
      return "bg-emerald-50 text-emerald-700";
    case "error":
      return "bg-rose-50 text-rose-700";
    case "configured":
      return "bg-sky-50 text-sky-700";
    case "warning":
      return "bg-amber-50 text-amber-700";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

function serializeOptionValue(value: unknown) {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return `number:${value}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  return `json:${JSON.stringify(value)}`;
}

function normalizeOption(option: any): FieldOption {
  if (option && typeof option === "object" && "value" in option) {
    return {
      label: String(option.label ?? option.value),
      value: option.value,
    };
  }

  return {
    label: String(option),
    value: option,
  };
}

function normalizeField(field: any): FieldDefinition {
  return {
    key: String(field?.key || ""),
    label: String(field?.label || field?.key || "Field"),
    type: String(field?.type || "text"),
    required: field?.required === true,
    requiredWhen:
      field?.requiredWhen && typeof field.requiredWhen === "object"
        ? {
            key: field.requiredWhen.key ? String(field.requiredWhen.key) : undefined,
            value: field.requiredWhen.value,
            values: Array.isArray(field.requiredWhen.values)
              ? field.requiredWhen.values
              : undefined,
          }
        : undefined,
    placeholder: String(field?.placeholder || ""),
    help: String(field?.help || ""),
    itemType: field?.itemType ? String(field.itemType) : undefined,
    defaultValue: field?.defaultValue,
    options: Array.isArray(field?.options) ? field.options.map(normalizeOption) : [],
  };
}

function normalizeTypeDefinition(raw: any): ChannelTypeDefinition {
  const id = getTypeId(raw);
  const configFields = Array.isArray(raw?.configFields)
    ? raw.configFields.map(normalizeField).filter((field) => field.key)
    : [];
  const hasComplexFields = raw?.hasComplexFields === true;

  return {
    id,
    type: id,
    label: String(raw?.label || raw?.title || raw?.detailLabel || id || "Channel"),
    title: String(raw?.title || raw?.label || raw?.detailLabel || id || "Channel"),
    detailLabel: String(raw?.detailLabel || raw?.label || raw?.title || id || "Channel"),
    description: String(raw?.description || ""),
    icon: raw?.icon ? String(raw.icon) : null,
    systemImage: raw?.systemImage ? String(raw.systemImage) : null,
    configFields,
    hasComplexFields,
    detailsLoaded:
      Array.isArray(raw?.configFields) ||
      typeof raw?.description === "string" ||
      typeof raw?.hasComplexFields === "boolean",
    actions:
      raw?.actions && typeof raw.actions === "object"
        ? {
            canQrLogin: raw.actions.canQrLogin === true,
            canLogout: raw.actions.canLogout === true,
            loginKind: raw.actions.loginKind ? String(raw.actions.loginKind) : null,
          }
        : {
            canQrLogin: false,
            canLogout: false,
            loginKind: null,
          },
  };
}

function normalizeChannel(raw: any): ChannelRecord {
  return {
    id: String(raw?.id || raw?.type || ""),
    type: getTypeId(raw),
    name: String(raw?.name || raw?.selectionLabel || raw?.detailLabel || raw?.type || "Channel"),
    selectionLabel: raw?.selectionLabel ? String(raw.selectionLabel) : undefined,
    detailLabel: raw?.detailLabel ? String(raw.detailLabel) : undefined,
    icon: raw?.icon ? String(raw.icon) : null,
    systemImage: raw?.systemImage ? String(raw.systemImage) : null,
    configured: raw?.configured !== false,
    enabled: raw?.enabled !== false,
    readOnly: raw?.readOnly === true,
    accountCount: Number.isFinite(raw?.accountCount) ? Number(raw.accountCount) : 0,
    defaultAccountId: raw?.defaultAccountId ? String(raw.defaultAccountId) : null,
    accounts: Array.isArray(raw?.accounts) ? raw.accounts : [],
    config: raw?.config && typeof raw.config === "object" ? raw.config : {},
    status:
      raw?.status && typeof raw.status === "object"
        ? {
            state: raw.status.state ? String(raw.status.state) : null,
            connected: raw.status.connected === true,
            running: raw.status.running === true,
            healthState: raw.status.healthState ? String(raw.status.healthState) : null,
            lastError: raw.status.lastError ? String(raw.status.lastError) : null,
            lastConnectedAt: raw.status.lastConnectedAt ? String(raw.status.lastConnectedAt) : null,
            lastProbeAt: raw.status.lastProbeAt ? String(raw.status.lastProbeAt) : null,
          }
        : {
            state: raw?.enabled === false ? "disabled" : "configured",
            connected: false,
            running: false,
            healthState: null,
            lastError: null,
            lastConnectedAt: null,
            lastProbeAt: null,
          },
    actions:
      raw?.actions && typeof raw.actions === "object"
        ? {
            canEdit: raw.actions.canEdit !== false,
            canToggle: raw.actions.canToggle !== false,
            canDelete: raw.actions.canDelete !== false,
            canTest: raw.actions.canTest === true,
            canViewMessages: raw.actions.canViewMessages === true,
            canQrLogin: raw.actions.canQrLogin === true,
            canLogout: raw.actions.canLogout === true,
            loginKind: raw.actions.loginKind ? String(raw.actions.loginKind) : null,
          }
        : {
            canEdit: true,
            canToggle: true,
            canDelete: true,
            canTest: true,
            canViewMessages: true,
            canQrLogin: false,
            canLogout: false,
            loginKind: null,
          },
  };
}

function normalizePayload(raw: any): ChannelsPayload {
  if (Array.isArray(raw)) {
    return {
      ...DEFAULT_PAYLOAD,
      channels: raw.map(normalizeChannel),
    };
  }

  return {
    runtime: String(raw?.runtime || DEFAULT_PAYLOAD.runtime),
    title: String(raw?.title || DEFAULT_PAYLOAD.title),
    description: String(raw?.description || DEFAULT_PAYLOAD.description),
    capabilities: {
      supportsTesting:
        raw?.capabilities?.supportsTesting ?? DEFAULT_PAYLOAD.capabilities.supportsTesting,
      supportsMessageHistory:
        raw?.capabilities?.supportsMessageHistory ??
        DEFAULT_PAYLOAD.capabilities.supportsMessageHistory,
      supportsArbitraryNames:
        raw?.capabilities?.supportsArbitraryNames ??
        DEFAULT_PAYLOAD.capabilities.supportsArbitraryNames,
      supportsLazyTypeDefinitions:
        raw?.capabilities?.supportsLazyTypeDefinitions ??
        DEFAULT_PAYLOAD.capabilities.supportsLazyTypeDefinitions,
    },
    channels: Array.isArray(raw?.channels) ? raw.channels.map(normalizeChannel) : [],
    availableTypes: Array.isArray(raw?.availableTypes)
      ? raw.availableTypes.map(normalizeTypeDefinition)
      : [],
  };
}

function glyphForType(channel: ChannelRecord, typeDefinition: ChannelTypeDefinition | null) {
  const type = channel.type || getTypeId(typeDefinition);
  if (CHANNEL_GLYPHS[type]) {
    return CHANNEL_GLYPHS[type];
  }

  const label =
    channel.selectionLabel ||
    channel.detailLabel ||
    typeDefinition?.detailLabel ||
    channel.name ||
    type ||
    "?";
  return label.slice(0, 2).toUpperCase();
}

function buildChannelFromTypeDefinition(
  typeName: string,
  definition: ChannelTypeDefinition | null,
): ChannelRecord {
  const normalizedType = String(typeName || getTypeId(definition))
    .trim()
    .toLowerCase();
  return {
    id: normalizedType,
    type: normalizedType,
    name:
      definition?.title ||
      definition?.detailLabel ||
      definition?.label ||
      prettifyStatus(normalizedType),
    selectionLabel: definition?.label,
    detailLabel: definition?.detailLabel || definition?.label,
    configured: false,
    enabled: false,
    readOnly: false,
    accountCount: 0,
    defaultAccountId: "default",
    accounts: [],
    config: {},
    status: {
      state: "not_configured",
      connected: false,
      running: false,
      healthState: null,
      lastError: null,
      lastConnectedAt: null,
      lastProbeAt: null,
    },
    actions: {
      canEdit: true,
      canToggle: false,
      canDelete: false,
      canTest: false,
      canViewMessages: false,
      canQrLogin: definition?.actions?.canQrLogin === true,
      canLogout: definition?.actions?.canLogout === true,
      loginKind: definition?.actions?.loginKind || null,
    },
  };
}

function getValueAtPath(source: Record<string, any>, path: string) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce<any>((current, segment) => {
      if (current == null || typeof current !== "object") return undefined;
      return current[segment];
    }, source);
}

function setValueAtPath(target: Record<string, any>, path: string, value: unknown) {
  const segments = String(path || "")
    .split(".")
    .filter(Boolean);
  if (segments.length === 0) return target;

  let cursor: Record<string, any> = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;

    if (last) {
      cursor[segment] = value;
      break;
    }

    const nextValue = cursor[segment];
    if (!nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }

  return target;
}

function defaultBooleanValue(field: FieldDefinition, currentValue: unknown) {
  if (typeof currentValue === "boolean") return currentValue;
  if (typeof field.defaultValue === "boolean") return field.defaultValue;
  return /\benabled\b/i.test(field.key) || /\benabled\b/i.test(field.label);
}

function buildFormValues(
  definition: ChannelTypeDefinition | null,
  currentConfig: Record<string, any> = {},
) {
  const values: FormValues = {};

  for (const field of definition?.configFields || []) {
    const currentValue = getValueAtPath(currentConfig, field.key);
    const value =
      currentValue === undefined || currentValue === null ? field.defaultValue : currentValue;

    if (field.type === "boolean") {
      values[field.key] = defaultBooleanValue(field, value);
      continue;
    }

    if (field.type === "list") {
      values[field.key] = Array.isArray(value)
        ? value.map((entry) => String(entry)).join("\n")
        : "";
      continue;
    }

    if (field.type === "select") {
      if (value === undefined || value === null || value === "") {
        values[field.key] = "";
        continue;
      }

      const match = (field.options || []).find(
        (option) => serializeOptionValue(option.value) === serializeOptionValue(value),
      );
      values[field.key] = match ? serializeOptionValue(match.value) : "";
      continue;
    }

    if (field.type === "password") {
      values[field.key] = value && value !== REDACTED_SECRET ? String(value) : "";
      continue;
    }

    if (field.type === "json") {
      if (value == null || value === "") {
        values[field.key] = "";
      } else if (typeof value === "string") {
        values[field.key] = value;
      } else {
        values[field.key] = JSON.stringify(value, null, 2);
      }
      continue;
    }

    values[field.key] = value == null ? "" : String(value);
  }

  return values;
}

function hasRequiredValue(
  field: FieldDefinition,
  rawValue: string | boolean | undefined,
  currentValue: unknown,
) {
  if (field.type === "boolean") return true;
  if (field.type === "list") {
    return (
      String(rawValue || "")
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean).length > 0
    );
  }
  if (field.type === "password") {
    return String(rawValue || "").trim() !== "" || currentValue === REDACTED_SECRET;
  }
  if (field.type === "select") {
    return String(rawValue || "").trim() !== "";
  }
  return String(rawValue || "").trim() !== "";
}

function requiredWhenMatches(field: FieldDefinition, formValues: FormValues) {
  const condition = field.requiredWhen;
  const conditionKey = condition?.key;
  if (!conditionKey) return false;

  const actualValue = formValues[conditionKey];
  const expectedValues = Array.isArray(condition.values) ? condition.values : [condition.value];
  return expectedValues.some((expectedValue) => {
    if (expectedValue === undefined) return false;
    return (
      String(actualValue) === String(expectedValue) ||
      String(actualValue) === serializeOptionValue(expectedValue)
    );
  });
}

function fieldIsRequired(field: FieldDefinition, formValues: FormValues) {
  return field.required === true || requiredWhenMatches(field, formValues);
}

function parseListValue(value: string, itemType: string | undefined) {
  const items = String(value || "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (itemType === "integer") {
    return items.map((entry) => {
      const parsed = Number.parseInt(entry, 10);
      if (Number.isNaN(parsed)) {
        throw new Error(`Expected integer list item, received "${entry}"`);
      }
      return parsed;
    });
  }

  if (itemType === "number") {
    return items.map((entry) => {
      const parsed = Number(entry);
      if (Number.isNaN(parsed)) {
        throw new Error(`Expected numeric list item, received "${entry}"`);
      }
      return parsed;
    });
  }

  return items;
}

function buildConfigFromForm(
  definition: ChannelTypeDefinition | null,
  formValues: FormValues,
  currentConfig: Record<string, any>,
  options: { omitEmptyOptional?: boolean } = {},
) {
  const nextConfig: Record<string, any> = {};
  const missingFields: string[] = [];

  for (const field of definition?.configFields || []) {
    const currentValue = getValueAtPath(currentConfig, field.key);
    const rawValue = formValues[field.key];
    const required = fieldIsRequired(field, formValues);

    if (required && !hasRequiredValue(field, rawValue, currentValue)) {
      missingFields.push(field.label);
      continue;
    }

    const rawString = typeof rawValue === "boolean" ? "" : String(rawValue || "");
    const isBlankOptional =
      !required &&
      field.type !== "boolean" &&
      rawString.trim() === "" &&
      (currentValue === undefined || currentValue === null || currentValue === "");
    if (options.omitEmptyOptional && isBlankOptional) {
      continue;
    }

    let parsedValue: unknown;
    switch (field.type) {
      case "boolean":
        parsedValue = Boolean(rawValue);
        break;
      case "integer": {
        const parsed = Number.parseInt(String(rawValue || ""), 10);
        if (String(rawValue || "").trim() === "") {
          parsedValue = "";
        } else if (Number.isNaN(parsed)) {
          throw new Error(`${field.label} must be an integer`);
        } else {
          parsedValue = parsed;
        }
        break;
      }
      case "number": {
        const parsed = Number(String(rawValue || ""));
        if (String(rawValue || "").trim() === "") {
          parsedValue = "";
        } else if (Number.isNaN(parsed)) {
          throw new Error(`${field.label} must be a number`);
        } else {
          parsedValue = parsed;
        }
        break;
      }
      case "list":
        parsedValue = parseListValue(String(rawValue || ""), field.itemType);
        break;
      case "select": {
        const option = (field.options || []).find(
          (candidate) => serializeOptionValue(candidate.value) === String(rawValue || ""),
        );
        parsedValue = option ? option.value : "";
        break;
      }
      case "json": {
        const trimmed = String(rawValue || "").trim();
        if (!trimmed) {
          parsedValue = "";
        } else {
          try {
            parsedValue = JSON.parse(trimmed);
          } catch {
            throw new Error(`${field.label} must be valid JSON`);
          }
        }
        break;
      }
      case "password":
        parsedValue =
          String(rawValue || "").trim() === "" && currentValue === REDACTED_SECRET
            ? REDACTED_SECRET
            : String(rawValue || "");
        break;
      default:
        parsedValue = String(rawValue || "");
        break;
    }

    setValueAtPath(nextConfig, field.key, parsedValue);
  }

  return { config: nextConfig, missingFields };
}

function extractQrDataUrl(payload: any) {
  const candidates = [
    payload?.qrDataUrl,
    payload?.qr_data_url,
    payload?.dataUrl,
    payload?.imageDataUrl,
    payload?.image,
    payload?.qr?.dataUrl,
  ];

  return candidates.find((value) => typeof value === "string" && value.trim()) || "";
}

function extractQrText(payload: any) {
  const candidates = [
    payload?.qrText,
    payload?.qr_text,
    payload?.qr,
    payload?.code,
    payload?.pairingCode,
    payload?.log,
    payload?.stdout,
    payload?.output,
  ];

  return candidates.find((value) => typeof value === "string" && value.trim()) || "";
}

function loginCompleted(payload: any) {
  const status = String(payload?.status || payload?.state || "")
    .trim()
    .toLowerCase();
  return (
    payload?.success === true ||
    payload?.connected === true ||
    payload?.linked === true ||
    status === "connected" ||
    status === "linked" ||
    status === "complete" ||
    status === "completed" ||
    status === "success"
  );
}

function describeLoginResult(payload: any) {
  const candidates = [payload?.message, payload?.statusMessage, payload?.state, payload?.status];

  const match = candidates.find((value) => typeof value === "string" && value.trim());
  return match ? String(match) : "";
}

function isWaitTimeoutMessage(message: string) {
  return /timeout|timed out|still waiting|no login event/i.test(message);
}

function ChannelStatePill({
  enabled,
  state,
}: {
  enabled: boolean;
  state: string | null | undefined;
}) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${channelTone(state, enabled)}`}
    >
      {prettifyStatus(enabled ? state || "configured" : "disabled")}
    </span>
  );
}

function ChannelFieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDefinition;
  value: string | boolean | undefined;
  onChange: (nextValue: string | boolean) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm font-medium text-slate-700">{field.label}</span>
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <select
        value={String(value || "")}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
      >
        <option value="">Select...</option>
        {(field.options || []).map((option) => {
          const optionValue = serializeOptionValue(option.value);
          return (
            <option key={optionValue} value={optionValue}>
              {option.label}
            </option>
          );
        })}
      </select>
    );
  }

  if (field.type === "textarea" || field.type === "list" || field.type === "json") {
    return (
      <textarea
        value={String(value || "")}
        onChange={(event) => onChange(event.target.value)}
        rows={field.type === "list" ? 4 : field.type === "json" ? 8 : 5}
        placeholder={field.placeholder || ""}
        className={`min-h-[120px] w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20 ${
          field.type === "json" ? "font-mono" : ""
        }`}
      />
    );
  }

  return (
    <input
      type={
        field.type === "password" ||
        field.type === "email" ||
        field.type === "url" ||
        field.type === "number"
          ? field.type
          : field.type === "integer"
            ? "number"
            : "text"
      }
      step={field.type === "integer" ? "1" : field.type === "number" ? "any" : undefined}
      value={typeof value === "boolean" ? "" : String(value || "")}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder || ""}
      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
    />
  );
}

function InlineQrPairingPanel({
  state,
  onCheck,
}: {
  state: CreatePairingState;
  onCheck: () => void;
}) {
  return (
    <div className="space-y-4">
      {state.error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-600" />
          <div>
            <p className="text-sm font-bold text-rose-800">Connect flow failed</p>
            <p className="mt-1 text-xs text-rose-700">{state.error}</p>
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        {state.qrDataUrl ? (
          <img
            src={state.qrDataUrl}
            alt={`${prettifyStatus(state.channelType)} login QR code`}
            className="mx-auto h-72 w-72 rounded-2xl border border-slate-200 bg-white object-contain p-4"
          />
        ) : state.qrText ? (
          <pre className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-4 text-[11px] text-slate-700">
            {state.qrText}
          </pre>
        ) : (
          <div className="flex min-h-[288px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white text-center">
            <div>
              <QrCode size={28} className="mx-auto text-slate-300" />
              <p className="mt-3 text-sm font-bold text-slate-600">
                {state.starting
                  ? "Generating a fresh QR code..."
                  : state.error
                    ? "Connect flow needs retry"
                    : "Ready to connect"}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
            Pairing Status
          </p>
          <p className="mt-2 text-sm font-medium text-slate-700">
            {state.status ||
              (state.error
                ? "Retry the connect flow to generate a QR code."
                : "Start the connect flow to generate a QR code.")}
          </p>
        </div>
        {(state.qrDataUrl || state.qrText) && !state.error ? (
          <button
            onClick={onCheck}
            disabled={state.starting || state.checking}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            {state.checking ? <Loader2 size={12} className="animate-spin" /> : <QrCode size={12} />}
            Check Status
          </button>
        ) : null}
      </div>
    </div>
  );
}

function QrLoginDialog({
  state,
  onClose,
  onRefresh,
  onCheck,
}: {
  state: LoginModalState;
  onClose: () => void;
  onRefresh: () => void;
  onCheck: () => void;
}) {
  if (!state.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-sm font-bold text-slate-900">
              {state.channel?.name || "Channel"} QR Login
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              LPanel is forwarding this pairing flow through the underlying OpenClaw gateway.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 transition-colors hover:text-slate-600"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {state.error ? (
            <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-600" />
              <div>
                <p className="text-sm font-bold text-rose-800">Login flow failed</p>
                <p className="mt-1 text-xs text-rose-700">{state.error}</p>
              </div>
            </div>
          ) : null}

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            {state.qrDataUrl ? (
              <img
                src={state.qrDataUrl}
                alt={`${state.channel?.name || "Channel"} login QR code`}
                className="mx-auto h-72 w-72 rounded-2xl border border-slate-200 bg-white object-contain p-4"
              />
            ) : state.qrText ? (
              <pre className="overflow-x-auto rounded-2xl border border-slate-200 bg-white p-4 text-[11px] text-slate-700">
                {state.qrText}
              </pre>
            ) : (
              <div className="flex min-h-[288px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white text-center">
                <div>
                  <QrCode size={28} className="mx-auto text-slate-300" />
                  <p className="mt-3 text-sm font-bold text-slate-600">
                    {state.starting ? "Generating a fresh QR code..." : "Waiting for QR data"}
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              Pairing Status
            </p>
            <p className="mt-2 text-sm font-medium text-slate-700">
              {state.status ||
                "Scan the QR code in your messaging app, then check the login state."}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-xl px-3 py-2 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100"
          >
            Close
          </button>
          <button
            onClick={onRefresh}
            disabled={state.starting}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            {state.starting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Refresh QR
          </button>
          <button
            onClick={onCheck}
            disabled={state.starting || state.checking}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {state.checking ? <Loader2 size={12} className="animate-spin" /> : <QrCode size={12} />}
            Check Status
          </button>
        </div>
      </div>
    </div>
  );
}

async function parseJson(res: Response) {
  return res.json().catch(() => ({}));
}

export default function ChannelsTab({ agentId }: { agentId: string }) {
  const [payload, setPayload] = useState<ChannelsPayload>(normalizePayload(DEFAULT_PAYLOAD));
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [selectedType, setSelectedType] = useState("");
  const [editingChannelId, setEditingChannelId] = useState("");
  const [editorName, setEditorName] = useState("");
  const [editorError, setEditorError] = useState("");
  const [formValues, setFormValues] = useState<FormValues>({});
  const [typeDefinitions, setTypeDefinitions] = useState<Record<string, ChannelTypeDefinition>>({});
  const [loadingType, setLoadingType] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedChannelId, setExpandedChannelId] = useState("");
  const [messages, setMessages] = useState<Record<string, MessageRecord[]>>({});
  const [loadingMessagesId, setLoadingMessagesId] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [loginState, setLoginState] = useState<LoginModalState>({
    open: false,
    channel: null,
    qrDataUrl: "",
    qrText: "",
    status: "",
    error: "",
    starting: false,
    checking: false,
  });
  const [createPairingState, setCreatePairingState] = useState<CreatePairingState>(() =>
    createEmptyCreatePairingState(),
  );
  const [secretReveal, setSecretReveal] = useState<SecretReveal | null>(null);
  const toast = useToast();
  const typeRequestRef = useRef(0);
  const loginPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createLoginPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createAutoConnectKeyRef = useRef("");

  function clearLoginPolling() {
    if (!loginPollTimerRef.current) return;
    clearTimeout(loginPollTimerRef.current);
    loginPollTimerRef.current = null;
  }

  function clearCreateLoginPolling() {
    if (!createLoginPollTimerRef.current) return;
    clearTimeout(createLoginPollTimerRef.current);
    createLoginPollTimerRef.current = null;
  }

  function resetCreatePairingState(channelType = "") {
    clearCreateLoginPolling();
    createAutoConnectKeyRef.current = "";
    setCreatePairingState(createEmptyCreatePairingState(channelType));
  }

  function closeEditor() {
    resetCreatePairingState();
    setShowEditor(false);
    setEditorMode("create");
    setSelectedType("");
    setEditingChannelId("");
    setEditorName("");
    setEditorError("");
    setFormValues({});
    setLoadingType(false);
    setSaving(false);
  }

  function closeLoginDialog() {
    clearLoginPolling();
    setLoginState({
      open: false,
      channel: null,
      qrDataUrl: "",
      qrText: "",
      status: "",
      error: "",
      starting: false,
      checking: false,
    });
  }

  async function loadChannels({ quiet = false } = {}) {
    if (quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels`);
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to load channels");
      }

      const nextPayload = normalizePayload(data);
      setPayload(nextPayload);
      setTypeDefinitions((current) => {
        const next = { ...current };
        for (const entry of nextPayload.availableTypes) {
          if (entry.detailsLoaded) {
            next[entry.type] = entry;
          }
        }
        return next;
      });
    } catch (nextError: any) {
      setError(nextError.message || "Failed to load channels");
      setPayload(normalizePayload(DEFAULT_PAYLOAD));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    closeEditor();
    closeLoginDialog();
    setTypeDefinitions({});
    setMessages({});
    setExpandedChannelId("");
    void loadChannels();
  }, [agentId]);

  useEffect(() => {
    return () => {
      clearLoginPolling();
      clearCreateLoginPolling();
    };
  }, []);

  async function ensureTypeDefinition(typeName: string) {
    const normalizedType = String(typeName || "")
      .trim()
      .toLowerCase();
    if (!normalizedType) return null;

    const cached = typeDefinitions[normalizedType];
    if (cached?.detailsLoaded) {
      return cached;
    }

    const baseDefinition =
      cached ||
      payload.availableTypes.find(
        (entry) => entry.type === normalizedType || entry.id === normalizedType,
      ) ||
      null;

    if (
      baseDefinition?.detailsLoaded ||
      (!payload.capabilities.supportsLazyTypeDefinitions && baseDefinition)
    ) {
      if (baseDefinition && !typeDefinitions[normalizedType]) {
        setTypeDefinitions((current) => ({
          ...current,
          [normalizedType]: baseDefinition,
        }));
      }
      return baseDefinition;
    }

    const requestId = typeRequestRef.current + 1;
    typeRequestRef.current = requestId;
    setLoadingType(true);

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/types/${normalizedType}`);
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to load channel type");
      }

      const resolvedDefinition = {
        ...(baseDefinition || {}),
        ...normalizeTypeDefinition(data),
        detailsLoaded: true,
      };

      if (typeRequestRef.current === requestId) {
        setTypeDefinitions((current) => ({
          ...current,
          [normalizedType]: resolvedDefinition,
        }));
      }

      return resolvedDefinition;
    } catch (nextError: any) {
      const message = nextError.message || "Failed to load channel type";
      setEditorError(message);
      toast.error(message);
      return baseDefinition;
    } finally {
      if (typeRequestRef.current === requestId) {
        setLoadingType(false);
      }
    }
  }

  async function prepareEditor(
    mode: "create" | "edit",
    typeName: string,
    channel: ChannelRecord | null,
  ) {
    resetCreatePairingState(mode === "create" ? typeName : "");
    setShowEditor(true);
    setEditorMode(mode);
    setSelectedType(typeName);
    setEditingChannelId(channel?.id || "");
    setEditorName(channel?.name || "");
    setEditorError("");
    setFormValues({});

    const definition = await ensureTypeDefinition(typeName);
    setFormValues(buildFormValues(definition, channel?.config || {}));
  }

  const configuredTypeIds = new Set(payload.channels.map((channel) => channel.type));
  const creatableTypes = payload.capabilities.supportsArbitraryNames
    ? payload.availableTypes
    : payload.availableTypes.filter((type) => !configuredTypeIds.has(type.type));
  const totalConfigured = payload.channels.filter((channel) => channel.configured).length;
  const totalEnabled = payload.channels.filter((channel) => channel.enabled !== false).length;
  const totalErrors = payload.channels.filter((channel) =>
    Boolean(channel.status?.lastError),
  ).length;

  async function openCreateEditor() {
    const firstType = getTypeId(creatableTypes[0]);
    if (!firstType) return;
    await prepareEditor("create", firstType, null);
  }

  async function openEditEditor(channel: ChannelRecord) {
    await prepareEditor("edit", channel.type, channel);
  }

  async function handleEditorTypeChange(nextType: string) {
    resetCreatePairingState(nextType);
    setSelectedType(nextType);
    setEditorError("");
    setFormValues({});

    const definition = await ensureTypeDefinition(nextType);
    setFormValues(buildFormValues(definition, {}));
  }

  async function handleSave() {
    const normalizedType = String(selectedType || "")
      .trim()
      .toLowerCase();
    if (!normalizedType) return;

    const definition = await ensureTypeDefinition(normalizedType);
    const editingChannel =
      payload.channels.find((channel) => channel.id === editingChannelId) || null;
    const currentConfig = editingChannel?.config || {};

    try {
      const { config, missingFields } = buildConfigFromForm(definition, formValues, currentConfig, {
        omitEmptyOptional: payload.runtime === "openclaw",
      });
      if (missingFields.length > 0) {
        toast.error(`Please fill in: ${missingFields.join(", ")}`);
        return;
      }

      if (payload.capabilities.supportsArbitraryNames && !editorName.trim()) {
        toast.error("Channel name is required");
        return;
      }

      setSaving(true);
      setEditorError("");

      const endpoint =
        editorMode === "create"
          ? `/api/agents/${agentId}/channels`
          : `/api/agents/${agentId}/channels/${editingChannelId || normalizedType}`;
      const method = editorMode === "create" ? "POST" : "PATCH";
      const body: Record<string, any> = editorMode === "create" ? { type: normalizedType } : {};

      if (payload.capabilities.supportsArbitraryNames) {
        body.name = editorName.trim();
      }
      body.config = config;
      if (payload.runtime === "openclaw") {
        body.enabled = true;
      }

      const res = await fetchWithAuth(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to save channel");
      }

      const createdName = editorName.trim() || normalizedType;
      const reveal =
        payload.runtime !== "openclaw" && editorMode === "create"
          ? revealFromCreateResponse(data, createdName)
          : null;
      if (reveal) setSecretReveal(reveal);

      toast.success(
        payload.runtime === "openclaw"
          ? "Channel setup saved"
          : editorMode === "create"
            ? "Channel created"
            : "Channel updated",
      );
      closeEditor();
      await loadChannels({ quiet: true });
    } catch (nextError: any) {
      const message = nextError.message || "Failed to save channel";
      setEditorError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRotateSecret(channel: ChannelRecord) {
    if (
      !window.confirm(
        `Rotate the webhook secret for "${channel.name}"? Anything signing with the old secret will stop working.`,
      )
    ) {
      return;
    }
    setBusyAction(`${channel.id}:rotate`);
    try {
      const secret = generateInboundSecret();
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channel.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRotationBody(channel.config, secret)),
      });
      const data = await parseJson(res);
      if (!res.ok) throw new Error(data.error || "Failed to rotate secret");
      setSecretReveal({ channelName: channel.name, secret, reason: "rotated" });
      await loadChannels({ quiet: true });
    } catch (nextError: any) {
      toast.error(nextError.message || "Failed to rotate secret");
    } finally {
      setBusyAction("");
    }
  }

  async function handleDelete(channel: ChannelRecord) {
    setBusyAction(`${channel.id}:delete`);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channel.id}`, {
        method: "DELETE",
      });
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete channel");
      }

      toast.success(
        payload.runtime === "openclaw" ? "Channel configuration removed" : "Channel deleted",
      );
      await loadChannels({ quiet: true });
    } catch (nextError: any) {
      toast.error(nextError.message || "Failed to delete channel");
    } finally {
      setBusyAction("");
    }
  }

  async function handleToggle(channel: ChannelRecord) {
    setBusyAction(`${channel.id}:toggle`);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channel.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !channel.enabled }),
      });
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to update channel");
      }

      toast.success(channel.enabled ? "Channel disabled" : "Channel enabled");
      await loadChannels({ quiet: true });
    } catch (nextError: any) {
      toast.error(nextError.message || "Failed to update channel");
    } finally {
      setBusyAction("");
    }
  }

  async function handleTest(channel: ChannelRecord) {
    setBusyAction(`${channel.id}:test`);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channel.id}/test`, {
        method: "POST",
      });
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to test channel");
      }

      if (data.success) {
        toast.success(data.message || `${channel.name} is healthy`);
      } else {
        toast.error(data.error || data.message || `${channel.name} test failed`);
      }
    } catch (nextError: any) {
      toast.error(nextError.message || "Failed to test channel");
    } finally {
      setBusyAction("");
    }
  }

  async function toggleMessages(channel: ChannelRecord) {
    if (expandedChannelId === channel.id) {
      setExpandedChannelId("");
      return;
    }

    setExpandedChannelId(channel.id);
    setLoadingMessagesId(channel.id);

    try {
      const res = await fetchWithAuth(
        `/api/agents/${agentId}/channels/${channel.id}/messages?limit=50`,
      );
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to load channel messages");
      }

      setMessages((current) => ({
        ...current,
        [channel.id]: Array.isArray(data) ? [...data].reverse() : [],
      }));
    } catch {
      setMessages((current) => ({
        ...current,
        [channel.id]: [],
      }));
    } finally {
      setLoadingMessagesId("");
    }
  }

  async function checkLoginStatus(channelId: string, { silent = false } = {}) {
    setLoginState((current) =>
      current.open
        ? {
            ...current,
            checking: true,
            error: silent ? current.error : "",
          }
        : current,
    );

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channelId}/login/wait`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutMs: 1500 }),
      });
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to check login status");
      }

      if (loginCompleted(data)) {
        toast.success(describeLoginResult(data) || "Channel linked successfully");
        closeLoginDialog();
        await loadChannels({ quiet: true });
        return;
      }

      setLoginState((current) =>
        current.open
          ? {
              ...current,
              qrDataUrl: extractQrDataUrl(data) || current.qrDataUrl,
              qrText: extractQrText(data) || current.qrText,
              status:
                describeLoginResult(data) || current.status || "Waiting for the scan to complete.",
              error: "",
              checking: false,
            }
          : current,
      );

      clearLoginPolling();
      loginPollTimerRef.current = setTimeout(() => {
        void checkLoginStatus(channelId, { silent: true });
      }, 2500);
    } catch (nextError: any) {
      const message = nextError.message || "Failed to check login status";

      if (silent && isWaitTimeoutMessage(message)) {
        setLoginState((current) =>
          current.open
            ? {
                ...current,
                checking: false,
              }
            : current,
        );
        clearLoginPolling();
        loginPollTimerRef.current = setTimeout(() => {
          void checkLoginStatus(channelId, { silent: true });
        }, 2500);
        return;
      }

      setLoginState((current) =>
        current.open
          ? {
              ...current,
              error: message,
              checking: false,
            }
          : current,
      );
      if (!silent) {
        toast.error(message);
      }
    }
  }

  async function checkCreateConnectStatus(channelId: string, { silent = false } = {}) {
    setCreatePairingState((current) => ({
      ...current,
      checking: true,
      error: silent ? current.error : "",
    }));

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channelId}/login/wait`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutMs: 1500 }),
      });
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to check connect status");
      }

      if (loginCompleted(data)) {
        toast.success(describeLoginResult(data) || "Channel linked successfully");
        closeEditor();
        await loadChannels({ quiet: true });
        return;
      }

      setCreatePairingState((current) => ({
        ...current,
        qrDataUrl: extractQrDataUrl(data) || current.qrDataUrl,
        qrText: extractQrText(data) || current.qrText,
        status: describeLoginResult(data) || current.status || "Waiting for the scan to complete.",
        error: "",
        checking: false,
      }));

      clearCreateLoginPolling();
      createLoginPollTimerRef.current = setTimeout(() => {
        void checkCreateConnectStatus(channelId, { silent: true });
      }, 2500);
    } catch (nextError: any) {
      const message = nextError.message || "Failed to check connect status";

      if (silent && isWaitTimeoutMessage(message)) {
        setCreatePairingState((current) => ({
          ...current,
          checking: false,
        }));
        clearCreateLoginPolling();
        createLoginPollTimerRef.current = setTimeout(() => {
          void checkCreateConnectStatus(channelId, { silent: true });
        }, 2500);
        return;
      }

      setCreatePairingState((current) => ({
        ...current,
        error: message,
        checking: false,
      }));
      if (!silent) {
        toast.error(message);
      }
    }
  }

  async function handleCreateConnect() {
    const normalizedType = String(selectedType || "")
      .trim()
      .toLowerCase();
    if (!normalizedType) return;

    const definition = await ensureTypeDefinition(normalizedType);
    const channel = buildChannelFromTypeDefinition(normalizedType, definition);
    clearCreateLoginPolling();
    setSaving(true);
    setCreatePairingState({
      channelType: normalizedType,
      qrDataUrl: "",
      qrText: "",
      status: "Adding the channel and requesting a fresh QR code...",
      error: "",
      starting: true,
      checking: false,
    });

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${normalizedType}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force: true,
          accountId: channel.defaultAccountId || undefined,
          timeoutMs: 30000,
        }),
      });
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to connect channel");
      }

      const loginPayload = data?.login && typeof data.login === "object" ? data.login : data;
      if (loginCompleted(loginPayload)) {
        toast.success(describeLoginResult(loginPayload) || "Channel linked successfully");
        closeEditor();
        await loadChannels({ quiet: true });
        return;
      }

      setCreatePairingState({
        channelType: normalizedType,
        qrDataUrl: extractQrDataUrl(loginPayload) || extractQrDataUrl(data),
        qrText: extractQrText(loginPayload) || extractQrText(data),
        status:
          describeLoginResult(loginPayload) ||
          describeLoginResult(data) ||
          "Scan the QR code to link this channel.",
        error: "",
        starting: false,
        checking: false,
      });

      clearCreateLoginPolling();
      createLoginPollTimerRef.current = setTimeout(() => {
        void checkCreateConnectStatus(normalizedType, { silent: true });
      }, 2500);
    } catch (nextError: any) {
      const message = nextError.message || "Failed to connect channel";
      setCreatePairingState({
        channelType: normalizedType,
        qrDataUrl: "",
        qrText: "",
        status: "",
        error: message,
        starting: false,
        checking: false,
      });
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function handleQrLogin(channel: ChannelRecord) {
    clearLoginPolling();
    setBusyAction(`${channel.id}:login`);
    setLoginState({
      open: true,
      channel,
      qrDataUrl: "",
      qrText: "",
      status: "Requesting a fresh QR code...",
      error: "",
      starting: true,
      checking: false,
    });

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channel.id}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force: true,
          accountId: channel.defaultAccountId || undefined,
          timeoutMs: 30000,
        }),
      });
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to link channel");
      }

      const loginPayload = data?.login && typeof data.login === "object" ? data.login : data;
      if (loginCompleted(loginPayload)) {
        toast.success(describeLoginResult(loginPayload) || "Channel linked successfully");
        closeLoginDialog();
        await loadChannels({ quiet: true });
        return;
      }

      setLoginState({
        open: true,
        channel,
        qrDataUrl: extractQrDataUrl(loginPayload) || extractQrDataUrl(data),
        qrText: extractQrText(loginPayload) || extractQrText(data),
        status:
          describeLoginResult(loginPayload) ||
          describeLoginResult(data) ||
          "Scan the QR code in the messaging app to link the channel.",
        error: "",
        starting: false,
        checking: false,
      });

      clearLoginPolling();
      loginPollTimerRef.current = setTimeout(() => {
        void checkLoginStatus(channel.id, { silent: true });
      }, 2500);
    } catch (nextError: any) {
      const message = nextError.message || "Failed to link channel";
      setLoginState({
        open: true,
        channel,
        qrDataUrl: "",
        qrText: "",
        status: "",
        error: message,
        starting: false,
        checking: false,
      });
      toast.error(message);
    } finally {
      setBusyAction("");
    }
  }

  async function handleLogout(channel: ChannelRecord) {
    setBusyAction(`${channel.id}:logout`);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/channels/${channel.id}/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: channel.defaultAccountId || undefined,
        }),
      });
      const data = await parseJson(res);
      if (!res.ok) {
        throw new Error(data.error || "Failed to logout channel");
      }

      toast.success("Channel logged out");
      await loadChannels({ quiet: true });
    } catch (nextError: any) {
      toast.error(nextError.message || "Failed to logout channel");
    } finally {
      setBusyAction("");
    }
  }

  const selectedTypeDefinition =
    typeDefinitions[selectedType] ||
    payload.availableTypes.find(
      (entry) => entry.type === selectedType || entry.id === selectedType,
    ) ||
    null;
  const createUsesQrConnect =
    editorMode === "create" &&
    payload.runtime === "openclaw" &&
    selectedTypeDefinition?.actions?.canQrLogin === true;
  const createPairingHasQr = Boolean(createPairingState.qrDataUrl || createPairingState.qrText);

  useEffect(() => {
    const normalizedType = String(selectedType || "")
      .trim()
      .toLowerCase();
    if (!showEditor || !createUsesQrConnect || !normalizedType) return;
    if (
      createPairingState.starting ||
      createPairingState.qrDataUrl ||
      createPairingState.qrText ||
      createPairingState.error
    ) {
      return;
    }

    const key = `${agentId}:${normalizedType}`;
    if (createAutoConnectKeyRef.current === key) return;
    createAutoConnectKeyRef.current = key;
    void handleCreateConnect();
  }, [
    agentId,
    showEditor,
    createUsesQrConnect,
    selectedType,
    createPairingState.starting,
    createPairingState.qrDataUrl,
    createPairingState.qrText,
    createPairingState.error,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-700">
              {payload.runtime === "openclaw" ? "OpenClaw Catalog" : "LPanel Channels"}
            </p>
            <p className="mt-1 text-sm font-bold text-slate-900">{payload.title || "Channels"}</p>
            <p className="mt-1 text-xs text-slate-500">
              {payload.description ||
                (payload.runtime === "openclaw"
                  ? "LPanel manages the underlying OpenClaw channel configuration here."
                  : "Configure LPanel’s built-in channel adapters.")}
            </p>
            {payload.runtime === "openclaw" ? (
              <p className="mt-2 text-[11px] text-slate-500">
                Available channel types mirror the OpenClaw CLI catalog, including QR pairing where
                the gateway exposes it.
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void loadChannels({ quiet: true });
              }}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {refreshing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Refresh
            </button>
            {payload.runtime !== "openclaw" ? (
              <button
                onClick={() => {
                  void openCreateEditor();
                }}
                disabled={creatableTypes.length === 0}
                className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <MessagesSquare size={12} />
                Add Channel
              </button>
            ) : null}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              {payload.runtime === "openclaw" ? "Available" : "Configured"}
            </p>
            <p className="mt-2 text-sm font-bold text-slate-900">
              {payload.runtime === "openclaw" ? payload.channels.length : totalConfigured}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              {payload.runtime === "openclaw" ? "Enabled" : "Available Types"}
            </p>
            <p className="mt-2 text-sm font-bold text-slate-900">
              {payload.runtime === "openclaw" ? totalEnabled : payload.availableTypes.length}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              Needs Attention
            </p>
            <p className="mt-2 text-sm font-bold text-slate-900">{totalErrors}</p>
          </div>
        </div>

        {error ? (
          <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-600" />
            <div>
              <p className="text-sm font-bold text-rose-800">Channel request failed</p>
              <p className="mt-1 text-xs text-rose-700">{error}</p>
            </div>
          </div>
        ) : null}

        {payload.channels.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center">
            <MessagesSquare size={24} className="mx-auto text-slate-300" />
            <p className="mt-3 text-sm font-bold text-slate-600">
              {payload.runtime === "openclaw"
                ? "No OpenClaw channels are available yet"
                : "No channels configured yet"}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {payload.runtime === "openclaw"
                ? "Refresh once the OpenClaw gateway exposes its channel catalog."
                : "Add a channel to let this agent send and receive messages outside LPanel."}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {payload.channels.map((channel) => {
              const typeDefinition =
                typeDefinitions[channel.type] ||
                payload.availableTypes.find(
                  (entry) => entry.type === channel.type || entry.id === channel.type,
                ) ||
                null;
              const state = channel.status?.state || (channel.enabled ? "configured" : "disabled");
              const isLinked =
                channel.status?.connected === true ||
                channel.status?.state === "connected" ||
                channel.accounts?.some((account) => account.linked || account.connected) ||
                false;
              const displayLinked = channel.actions?.canQrLogin ? isLinked : channel.configured;
              const accountChips = (channel.accounts || []).slice(0, 3);
              const moreAccounts = Math.max(
                0,
                (channel.accounts || []).length - accountChips.length,
              );

              return (
                <div
                  key={channel.id}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-sm font-black text-slate-700">
                            {glyphForType(channel, typeDefinition)}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-slate-900">
                              {channel.name}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                                {channel.type}
                              </span>
                              <ChannelStatePill enabled={channel.enabled !== false} state={state} />
                              <span
                                className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${
                                  channel.enabled === false
                                    ? "bg-slate-100 text-slate-500"
                                    : "bg-emerald-50 text-emerald-700"
                                }`}
                              >
                                {channel.enabled === false ? "Disabled" : "Enabled"}
                              </span>
                            </div>
                          </div>
                        </div>

                        {channel.detailLabel && channel.detailLabel !== channel.name ? (
                          <p className="mt-3 text-sm text-slate-600">{channel.detailLabel}</p>
                        ) : null}

                        {channel.status?.lastError ? (
                          <p className="mt-2 text-xs text-rose-600">{channel.status.lastError}</p>
                        ) : null}

                        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                          <span className="rounded-full bg-slate-100 px-2.5 py-1">
                            configured: {channel.configured ? "yes" : "no"}
                          </span>
                          {payload.runtime === "openclaw" ? (
                            <>
                              <span className="rounded-full bg-slate-100 px-2.5 py-1">
                                linked: {displayLinked ? "yes" : "no"}
                              </span>
                              <span className="rounded-full bg-slate-100 px-2.5 py-1">
                                accounts: {channel.accountCount || 0}
                              </span>
                            </>
                          ) : null}
                          {channel.status?.healthState ? (
                            <span className="rounded-full bg-slate-100 px-2.5 py-1">
                              health: {prettifyStatus(channel.status.healthState)}
                            </span>
                          ) : null}
                          {channel.status?.lastConnectedAt ? (
                            <span className="rounded-full bg-slate-100 px-2.5 py-1">
                              last connected: {formatTimestamp(channel.status.lastConnectedAt)}
                            </span>
                          ) : null}
                        </div>

                        {accountChips.length > 0 ? (
                          <div className="mt-3">
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                              Accounts
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {accountChips.map((account) => (
                                <span
                                  key={`${channel.id}-${account.accountId}`}
                                  className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600"
                                >
                                  {account.name || account.accountId} ·{" "}
                                  {account.connected
                                    ? "connected"
                                    : account.running
                                      ? "running"
                                      : account.linked
                                        ? "linked"
                                        : account.configured
                                          ? "configured"
                                          : "idle"}
                                </span>
                              ))}
                              {moreAccounts > 0 ? (
                                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600">
                                  +{moreAccounts} more
                                </span>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {payload.runtime === "openclaw" && channel.actions?.canQrLogin ? (
                          <button
                            onClick={() => {
                              void handleQrLogin(channel);
                            }}
                            disabled={busyAction === `${channel.id}:login`}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50"
                          >
                            {busyAction === `${channel.id}:login` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Link2 size={12} />
                            )}
                            {isLinked ? "Relink" : "Link"}
                          </button>
                        ) : null}
                        {payload.runtime === "openclaw" &&
                        !channel.actions?.canQrLogin &&
                        channel.actions?.canEdit !== false &&
                        !channel.readOnly ? (
                          <button
                            onClick={() => {
                              void openEditEditor(channel);
                            }}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-50"
                          >
                            <Settings size={12} />
                            {channel.configured ? "Edit Setup" : "Setup"}
                          </button>
                        ) : null}
                        {payload.runtime !== "openclaw" &&
                        channel.actions?.canEdit !== false &&
                        !channel.readOnly ? (
                          <button
                            onClick={() => {
                              void openEditEditor(channel);
                            }}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
                          >
                            <Pencil size={12} />
                            Edit
                          </button>
                        ) : null}
                        {payload.runtime !== "openclaw" &&
                        channel.actions?.canEdit !== false &&
                        !channel.readOnly ? (
                          <button
                            onClick={() => {
                              void handleRotateSecret(channel);
                            }}
                            disabled={busyAction === `${channel.id}:rotate`}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
                          >
                            {busyAction === `${channel.id}:rotate` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <KeyRound size={12} />
                            )}
                            {channel.config?.inbound_secret ? "Rotate secret" : "Generate secret"}
                          </button>
                        ) : null}
                        {channel.actions?.canToggle !== false && channel.configured ? (
                          <button
                            onClick={() => {
                              void handleToggle(channel);
                            }}
                            disabled={busyAction === `${channel.id}:toggle`}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
                          >
                            {busyAction === `${channel.id}:toggle` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Power size={12} />
                            )}
                            {channel.enabled === false ? "Enable" : "Disable"}
                          </button>
                        ) : null}
                        {payload.capabilities.supportsTesting && channel.actions?.canTest ? (
                          <button
                            onClick={() => {
                              void handleTest(channel);
                            }}
                            disabled={busyAction === `${channel.id}:test`}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-sky-200 px-3 py-2 text-xs font-bold text-sky-700 transition-colors hover:bg-sky-50 disabled:opacity-50"
                          >
                            {busyAction === `${channel.id}:test` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <SearchCheck size={12} />
                            )}
                            Test
                          </button>
                        ) : null}
                        {payload.runtime !== "openclaw" && channel.actions?.canQrLogin ? (
                          <button
                            onClick={() => {
                              void handleQrLogin(channel);
                            }}
                            disabled={busyAction === `${channel.id}:login`}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50"
                          >
                            {busyAction === `${channel.id}:login` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <QrCode size={12} />
                            )}
                            QR Login
                          </button>
                        ) : null}
                        {channel.actions?.canLogout ? (
                          <button
                            onClick={() => {
                              void handleLogout(channel);
                            }}
                            disabled={busyAction === `${channel.id}:logout`}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-200 px-3 py-2 text-xs font-bold text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50"
                          >
                            {busyAction === `${channel.id}:logout` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <LogOut size={12} />
                            )}
                            Logout
                          </button>
                        ) : null}
                        {payload.runtime !== "openclaw" &&
                        channel.actions?.canDelete !== false &&
                        !channel.readOnly ? (
                          <button
                            onClick={() => {
                              void handleDelete(channel);
                            }}
                            disabled={busyAction === `${channel.id}:delete`}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 px-3 py-2 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
                          >
                            {busyAction === `${channel.id}:delete` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <X size={12} />
                            )}
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {payload.capabilities.supportsMessageHistory &&
                    channel.actions?.canViewMessages ? (
                      <div>
                        <button
                          onClick={() => {
                            void toggleMessages(channel);
                          }}
                          className="flex items-center gap-1 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-700"
                        >
                          {expandedChannelId === channel.id ? (
                            <ChevronUp size={12} />
                          ) : (
                            <ChevronDown size={12} />
                          )}
                          {expandedChannelId === channel.id ? "Hide" : "Show"} Messages
                        </button>

                        {expandedChannelId === channel.id ? (
                          <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            {loadingMessagesId === channel.id ? (
                              <div className="flex items-center justify-center py-8">
                                <Loader2 size={20} className="animate-spin text-blue-500" />
                              </div>
                            ) : (
                              <MessageTimeline messages={messages[channel.id] || []} />
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showEditor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 p-4">
              <div>
                <p className="text-sm font-bold text-slate-900">
                  {payload.runtime === "openclaw"
                    ? "Setup Channel"
                    : editorMode === "create"
                      ? "Add Channel"
                      : "Edit Channel"}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {payload.runtime === "openclaw"
                    ? createUsesQrConnect
                      ? "LPanel adds the channel through OpenClaw and starts the pairing flow."
                      : "LPanel writes the editable settings back through the underlying OpenClaw config API."
                    : "LPanel stores these adapter settings in its control-plane database."}
                </p>
              </div>
              <button
                onClick={closeEditor}
                className="text-slate-400 transition-colors hover:text-slate-600"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4 p-4">
              {editorMode === "create" ? (
                <div>
                  <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
                    Channel Type
                  </label>
                  <select
                    value={selectedType}
                    onChange={(event) => {
                      void handleEditorTypeChange(event.target.value);
                    }}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  >
                    {creatableTypes.map((type) => (
                      <option key={type.type} value={type.type}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {payload.capabilities.supportsArbitraryNames ? (
                <div>
                  <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
                    Channel Name
                  </label>
                  <input
                    type="text"
                    value={editorName}
                    onChange={(event) => setEditorName(event.target.value)}
                    placeholder="e.g. Ops Telegram"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  />
                </div>
              ) : null}

              {editorError ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {editorError}
                </div>
              ) : null}

              {loadingType ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 size={20} className="animate-spin text-blue-500" />
                </div>
              ) : createUsesQrConnect ? (
                <InlineQrPairingPanel
                  state={createPairingState}
                  onCheck={() => {
                    void checkCreateConnectStatus(selectedType);
                  }}
                />
              ) : (
                <>
                  {typeDefinitions[selectedType]?.description ||
                  payload.availableTypes.find((entry) => entry.type === selectedType)
                    ?.description ? (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                      {typeDefinitions[selectedType]?.description ||
                        payload.availableTypes.find((entry) => entry.type === selectedType)
                          ?.description}
                    </div>
                  ) : null}

                  {typeDefinitions[selectedType]?.hasComplexFields ||
                  payload.availableTypes.find((entry) => entry.type === selectedType)
                    ?.hasComplexFields ? (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      Some advanced runtime settings are not fully editable here yet. LPanel will
                      preserve the rest of the channel config when it saves.
                    </div>
                  ) : null}

                  {(
                    typeDefinitions[selectedType]?.configFields ||
                    payload.availableTypes.find((entry) => entry.type === selectedType)
                      ?.configFields ||
                    []
                  ).length > 0 ? (
                    <div className="space-y-4">
                      {(
                        typeDefinitions[selectedType]?.configFields ||
                        payload.availableTypes.find((entry) => entry.type === selectedType)
                          ?.configFields ||
                        []
                      ).map((field) => (
                        <div key={field.key}>
                          {field.type !== "boolean" ? (
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
                              {field.label}
                              {fieldIsRequired(field, formValues) ? (
                                <span className="ml-1 text-rose-500">*</span>
                              ) : null}
                            </label>
                          ) : null}

                          <ChannelFieldInput
                            field={field}
                            value={formValues[field.key]}
                            onChange={(nextValue) =>
                              setFormValues((current) => ({
                                ...current,
                                [field.key]: nextValue,
                              }))
                            }
                          />

                          {field.type === "list" ? (
                            <p className="mt-1 text-[11px] text-slate-500">
                              Enter one value per line.
                            </p>
                          ) : null}
                          {field.type === "json" ? (
                            <p className="mt-1 text-[11px] text-slate-500">
                              Paste a valid JSON object.
                            </p>
                          ) : null}
                          {field.type === "password" ? (
                            <p className="mt-1 text-[11px] text-slate-500">
                              Leave this blank to keep the existing stored secret.
                            </p>
                          ) : null}
                          {field.help ? (
                            <p className="mt-1 text-[11px] text-slate-500">{field.help}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                      This channel type does not expose additional editable LPanel fields yet.
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 p-4">
              <button
                onClick={closeEditor}
                className="rounded-xl px-3 py-2 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (createUsesQrConnect) {
                    void handleCreateConnect();
                    return;
                  }
                  void handleSave();
                }}
                disabled={
                  saving ||
                  loadingType ||
                  !selectedType ||
                  (createUsesQrConnect && createPairingState.checking)
                }
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {saving || createPairingState.starting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : createUsesQrConnect ? (
                  createPairingHasQr ? (
                    <RefreshCw size={12} />
                  ) : (
                    <QrCode size={12} />
                  )
                ) : (
                  <Save size={12} />
                )}
                {createUsesQrConnect
                  ? createPairingHasQr
                    ? "Refresh QR"
                    : "Connect Channel"
                  : payload.runtime === "openclaw"
                    ? "Save Setup"
                    : "Save Channel"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <InboundSecretDialog reveal={secretReveal} onClose={() => setSecretReveal(null)} />

      <QrLoginDialog
        state={loginState}
        onClose={closeLoginDialog}
        onRefresh={() => {
          if (loginState.channel) {
            void handleQrLogin(loginState.channel);
          }
        }}
        onCheck={() => {
          if (loginState.channel) {
            void checkLoginStatus(loginState.channel.id);
          }
        }}
      />
    </>
  );
}
