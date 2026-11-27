import type { z } from "zod";

export function jsonError(status: number, error: string, extra?: Record<string, unknown>): Response {
  return Response.json({ error, ...extra }, { status });
}

// Parse a JSON body against a zod schema. Returns the data, or a 400 Response to return as-is.
export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    // Strict schemas: an unknown (e.g. misspelled) field is named, never silently dropped.
    const unknown = result.error.issues.flatMap((i) => (i.code === "unrecognized_keys" ? i.keys.map((k) => [...i.path, k].join(".")) : []));
    const error = unknown.length ? `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` : "invalid request";
    return jsonError(400, error, { issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })) });
  }
  return result.data;
}
