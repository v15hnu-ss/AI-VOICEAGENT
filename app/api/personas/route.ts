import { db } from "@/lib/db"
import { personas } from "@/lib/db/schema"
import { asc } from "drizzle-orm"

export async function GET() {
  if (!process.env.DATABASE_URL) return Response.json([])
  const rows = await db.select().from(personas).orderBy(asc(personas.id))
  return Response.json(rows)
}

export async function POST(req: Request) {
  const body = await req.json()
  if (!body.name || !body.systemPrompt) {
    return Response.json({ error: "name and systemPrompt required" }, { status: 400 })
  }
  const [row] = await db
    .insert(personas)
    .values({
      name: String(body.name),
      role: String(body.role || "general"),
      description: body.description ? String(body.description) : null,
      systemPrompt: String(body.systemPrompt),
      language: body.language === "telugu" ? "telugu" : "hinglish",
      voice: String(body.voice || "abhilash"),
      greeting: body.greeting ? String(body.greeting) : null,
    })
    .returning()
  return Response.json(row)
}
