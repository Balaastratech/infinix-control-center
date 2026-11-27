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
    return jsonError(400, "invalid request", { issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })) });
  }
  return result.data;
}
