import { db } from "@/lib/db"
import { calls } from "@/lib/db/schema"
import { desc } from "drizzle-orm"

export async function GET() {
  if (!process.env.DATABASE_URL) return Response.json([])
  const rows = await db.select().from(calls).orderBy(desc(calls.startedAt)).limit(100)
  return Response.json(rows)
}

export async function POST(req: Request) {
  const { personaId, personaName, language } = await req.json()
  if (!process.env.DATABASE_URL) {
    return Response.json({
      id: Date.now(),
      personaId: personaId ?? null,
      personaName: personaName ?? null,
      language: language || "hinglish",
      status: "active",
      temporary: true,
    })
  }
  const [row] = await db
    .insert(calls)
    .values({
      personaId: personaId ?? null,
      personaName: personaName ?? null,
      language: language || "hinglish",
      status: "active",
    })
    .returning()
  return Response.json(row)
}
