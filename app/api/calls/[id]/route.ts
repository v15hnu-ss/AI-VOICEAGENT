import { db } from "@/lib/db"
import { calls, transcriptTurns } from "@/lib/db/schema"
import { asc, eq } from "drizzle-orm"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const callId = Number(id)
  if (!Number.isFinite(callId)) return Response.json({ error: "Invalid id" }, { status: 400 })

  const [call] = await db.select().from(calls).where(eq(calls.id, callId))
  if (!call) return Response.json({ error: "Not found" }, { status: 404 })

  const turns = await db
    .select()
    .from(transcriptTurns)
    .where(eq(transcriptTurns.callId, callId))
    .orderBy(asc(transcriptTurns.createdAt), asc(transcriptTurns.id))

  return Response.json({ ...call, turns })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const callId = Number(id)
  if (!Number.isFinite(callId)) return Response.json({ error: "Invalid id" }, { status: 400 })

  const body = await req.json()
  if (!process.env.DATABASE_URL) {
    return Response.json({ id: callId, ...body, temporary: true })
  }
  const update: Record<string, unknown> = {}

  if (body.status) update.status = body.status
  if (body.status === "completed") {
    update.endedAt = new Date()
    if (typeof body.durationSeconds === "number") update.durationSeconds = body.durationSeconds
    if (typeof body.avgLatencyMs === "number") update.avgLatencyMs = body.avgLatencyMs
    if (typeof body.turnCount === "number") update.turnCount = body.turnCount
  }

  const [row] = await db.update(calls).set(update).where(eq(calls.id, callId)).returning()
  return Response.json(row)
}
