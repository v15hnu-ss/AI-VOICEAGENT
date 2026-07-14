import { db } from "@/lib/db"
import { bookings } from "@/lib/db/schema"

export const maxDuration = 60

const TOOLS = [
  {
    type: "function",
    function: {
      name: "book_appointment",
      description:
        "Book a calendar appointment/meeting/demo/callback for the user. Use when the user asks to schedule anything.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title of the appointment" },
          contact_name: { type: "string", description: "Name of the person, if given" },
          scheduled_at: {
            type: "string",
            description:
              "ISO 8601 datetime for the appointment. Infer from conversation (e.g. 'kal 3 baje' = tomorrow 15:00 IST).",
          },
          notes: { type: "string", description: "Any extra context" },
        },
        required: ["title", "scheduled_at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current date and time (IST). Use when the user asks the time/date or for relative scheduling.",
      parameters: { type: "object", properties: {} },
    },
  },
]

async function executeTool(name: string, args: Record<string, unknown>, callId: number | null) {
  if (name === "get_current_time") {
    return {
      now_ist: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" }),
      iso: new Date().toISOString(),
    }
  }
  if (name === "book_appointment") {
    try {
      const scheduledAt = new Date(String(args.scheduled_at))
      if (isNaN(scheduledAt.getTime())) return { success: false, error: "Invalid date" }
      const title = String(args.title || "Appointment")
      if (!process.env.DATABASE_URL) {
        return {
          success: true,
          temporary: true,
          booking_id: `demo-${Date.now()}`,
          scheduled_at: scheduledAt.toISOString(),
          title,
        }
      }
      const [row] = await db
        .insert(bookings)
        .values({
          callId: callId ?? null,
          title,
          contactName: args.contact_name ? String(args.contact_name) : null,
          scheduledAt,
          notes: args.notes ? String(args.notes) : null,
          status: "confirmed",
        })
        .returning()
      return { success: true, booking_id: row.id, scheduled_at: row.scheduledAt.toISOString(), title: row.title }
    } catch (e) {
      console.error("[chat] booking error:", e)
      return { success: false, error: "Booking failed" }
    }
  }
  return { error: "Unknown tool" }
}

export async function POST(req: Request) {
  const { messages, systemPrompt, callId } = await req.json()

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))

      const convo: Array<Record<string, unknown>> = [
        {
          role: "system",
          content: `${systemPrompt}\n\nCurrent date/time (IST): ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}. Remember: you are on a LIVE VOICE CALL. Replies must be short, natural spoken sentences. No markdown, no lists, no emojis, no asterisks.`,
        },
        ...messages,
      ]

      try {
        // Tool-calling loop: stream text, execute tools, continue until final answer
        for (let round = 0; round < 4; round++) {
          const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "llama-3.3-70b-versatile",
              messages: convo,
              tools: TOOLS,
              tool_choice: "auto",
              stream: true,
              temperature: 0.6,
              max_tokens: 300,
            }),
          })

          if (!res.ok || !res.body) {
            const err = await res.text()
            console.error("[chat] Groq error:", res.status, err)
            send({ type: "error", message: "LLM request failed" })
            break
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          let fullText = ""
          let finishReason: string | null = null
          const toolCalls: Array<{ id: string; name: string; args: string }> = []

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith("data:")) continue
              const payload = trimmed.slice(5).trim()
              if (payload === "[DONE]") continue
              try {
                const json = JSON.parse(payload)
                const choice = json.choices?.[0]
                if (!choice) continue
                const delta = choice.delta
                if (delta?.content) {
                  fullText += delta.content
                  send({ type: "text", delta: delta.content })
                }
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0
                    if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || `call_${idx}`, name: "", args: "" }
                    if (tc.id) toolCalls[idx].id = tc.id
                    if (tc.function?.name) toolCalls[idx].name += tc.function.name
                    if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments
                  }
                }
                if (choice.finish_reason) finishReason = choice.finish_reason
              } catch {
                // partial JSON chunk, skip
              }
            }
          }

          if (finishReason === "tool_calls" && toolCalls.length > 0) {
            convo.push({
              role: "assistant",
              content: fullText || null,
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.args },
              })),
            })
            for (const tc of toolCalls) {
              let args: Record<string, unknown> = {}
              try {
                args = JSON.parse(tc.args || "{}")
              } catch {}
              send({ type: "tool_start", name: tc.name })
              const result = await executeTool(tc.name, args, callId ?? null)
              send({ type: "tool_result", name: tc.name, result })
              convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) })
            }
            continue // loop again so the model can respond with the tool result
          }

          break // normal completion
        }
      } catch (e) {
        console.error("[chat] stream error:", e)
        send({ type: "error", message: "Stream failed" })
      }

      send({ type: "done" })
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
