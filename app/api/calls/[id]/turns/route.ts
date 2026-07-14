import { db } from "@/lib/db"
import { transcriptTurns } from "@/lib/db/schema"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const callId = Number(id)
  if (!Number.isFinite(callId)) return Response.json({ error: "Invalid id" }, { status: 400 })

  const { speaker, content, latencyMs } = await req.json()
  if (!speaker || !content) return Response.json({ error: "Missing fields" }, { status: 400 })
  if (!process.env.DATABASE_URL) {
    return Response.json({ id: Date.now(), callId, speaker, content, latencyMs, temporary: true })
  }

  const [row] = await db
    .insert(transcriptTurns)
    .values({
      callId,
      speaker,
      content,
      latencyMs: typeof latencyMs === "number" ? Math.round(latencyMs) : null,
    })
    .returning()

  return Response.json(row)
}
