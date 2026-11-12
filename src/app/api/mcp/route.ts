import { NextRequest, NextResponse } from "next/server";

import { MODELS, getModel, parseSettings } from "@/generation/catalog";
import type { GenerationPlane, MediaItem, MediaRole } from "@/generation/catalog/types";
import { createPlatformClient } from "@/generation/platform";
import { toPlatform } from "@/generation/to-platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTOCOL_VERSION = "2025-03-26";
const ROLES = new Set<MediaRole>(["start", "end", "reference", "video", "audio"]);

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function jsonRpc(id: JsonRpcRequest["id"], result: unknown, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result }, { status });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, status = 200) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status },
  );
}

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function requireConfig(request: NextRequest) {
  const expected = process.env.MCP_ACCESS_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected) throw new Error("Server is missing MCP_ACCESS_TOKEN");
  if (!supplied || supplied !== expected) throw new Error("Unauthorized MCP request");
  const apiKey = process.env.HF_PLATFORM_API_KEY;
  const baseUrl = process.env.HF_API_BASE_URL;
  if (!apiKey || !baseUrl) throw new Error("Server requires HF_PLATFORM_API_KEY and HF_API_BASE_URL");
  return createPlatformClient({ apiKey, baseUrl });
}

function parseMedia(value: unknown): Partial<Record<MediaRole, MediaItem[]>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("media must be an object keyed by start, end, reference, video, or audio");
  }
  const output: Partial<Record<MediaRole, MediaItem[]>> = {};
  for (const [role, items] of Object.entries(value)) {
    if (!ROLES.has(role as MediaRole) || !Array.isArray(items)) throw new Error(`Invalid media role: ${role}`);
    output[role as MediaRole] = items.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error("Each media item must be an object");
      const record = item as Record<string, unknown>;
      if (typeof record.url !== "string" || !/^https:\/\//i.test(record.url)) {
        throw new Error("Each media item needs an HTTPS url");
      }
      return {
        id: typeof record.id === "string" ? record.id : `${role}-${index}`,
        url: record.url,
        role: role as MediaRole,
      };
    });
  }
  return output;
}

const tools = [
  {
    name: "openhiggsfield_list_models",
    description: "List every available OpenHiggsfield image and video model, including its accepted settings and media roles.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "openhiggsfield_generate",
    description: "Submit an image or video generation job. Choose a model ID from openhiggsfield_list_models. Returns a request ID; use openhiggsfield_check_status to retrieve the finished media.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Exact model ID from the model catalog." },
        prompt: { type: "string", description: "What to generate." },
        settings: { type: "object", description: "Optional model settings such as aspectRatio, resolution, duration, and model-specific options." },
        media: {
          type: "object",
          description: "Optional HTTPS media inputs grouped by role. Each role is an array of {url,id?} objects.",
          properties: {
            start: { type: "array", items: { type: "object", properties: { url: { type: "string" }, id: { type: "string" } }, required: ["url"] } },
            end: { type: "array", items: { type: "object", properties: { url: { type: "string" }, id: { type: "string" } }, required: ["url"] } },
            reference: { type: "array", items: { type: "object", properties: { url: { type: "string" }, id: { type: "string" } }, required: ["url"] } },
            video: { type: "array", items: { type: "object", properties: { url: { type: "string" }, id: { type: "string" } }, required: ["url"] } },
            audio: { type: "array", items: { type: "object", properties: { url: { type: "string" }, id: { type: "string" } }, required: ["url"] } },
          },
        },
      },
      required: ["model", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "openhiggsfield_check_status",
    description: "Check a generation job by request ID and return its current status and any generated image or video URLs.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
      additionalProperties: false,
    },
  },
];

export async function POST(request: NextRequest) {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  const id = body.id;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(id, -32600, "Invalid JSON-RPC request", 400);
  }
  if (body.method === "notifications/initialized" || body.method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202 });
  }
  if (body.method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "openhiggsfield", version: "1.0.0" },
      instructions: "Use openhiggsfield_list_models before generating. Generation is asynchronous; poll with openhiggsfield_check_status.",
    });
  }
  if (body.method === "ping") return jsonRpc(id, {});
  if (body.method === "tools/list") return jsonRpc(id, { tools });
  if (body.method !== "tools/call") return rpcError(id, -32601, "Method not found");

  try {
    const client = requireConfig(request);
    const params = body.params ?? {};
    const name = params.name;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof name !== "string") throw new Error("Tool name is required");

    if (name === "openhiggsfield_list_models") {
      return jsonRpc(id, textResult(MODELS.map((model) => ({
        id: model.id,
        label: model.label,
        surface: model.surface,
        settings: model.settings,
        mediaRoles: model.roles,
      }))));
    }

    if (name === "openhiggsfield_generate") {
      if (typeof args.model !== "string" || typeof args.prompt !== "string" || !args.prompt.trim()) {
        throw new Error("model and a non-empty prompt are required");
      }
      const model = getModel(args.model);
      const rawSettings = args.settings && typeof args.settings === "object" && !Array.isArray(args.settings)
        ? args.settings as Record<string, unknown>
        : {};
      const plane: GenerationPlane = {
        model: model.id,
        prompt: { text: args.prompt },
        media: parseMedia(args.media),
        settings: parseSettings(model, rawSettings),
      };
      const mapped = toPlatform(plane);
      const queued = await client.submit(mapped.path, mapped.body);
      return jsonRpc(id, textResult({ ...queued, model: model.id, surface: model.surface }));
    }

    if (name === "openhiggsfield_check_status") {
      if (typeof args.requestId !== "string" || !args.requestId) throw new Error("requestId is required");
      return jsonRpc(id, textResult(await client.status(args.requestId)));
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected MCP server error";
    const code = message === "Unauthorized MCP request" ? -32001 : -32000;
    return rpcError(id, code, message, code === -32001 ? 401 : 200);
  }
}

export async function GET() {
  return NextResponse.json(
    { name: "OpenHiggsfield MCP", endpoint: "/api/mcp", transport: "Streamable HTTP", status: "ready" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
