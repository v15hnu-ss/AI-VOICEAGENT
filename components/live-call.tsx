"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { VoiceOrb } from "@/components/voice-orb"
import { useVoiceAgent, type Persona } from "@/hooks/use-voice-agent"
import { cn } from "@/lib/utils"
import { CalendarCheck, Clock, Gauge, Mic, MicOff, Phone, PhoneOff, Zap } from "lucide-react"

const DEFAULT_PERSONAS: Persona[] = [
  {
    id: 1,
    name: "Ananya — Sales Consultant",
    role: "sales consultant",
    description: "A warm, persuasive Telugu sales consultant",
    language: "telugu",
    voice: "anushka",
    greeting: "నమస్కారం! నేను అనన్య. మీకు ఈరోజు ఎలా సహాయం చేయగలను?",
    systemPrompt:
      "You are Ananya, a warm and concise Telugu sales consultant. Speak naturally in Telugu, understand Telugu mixed with English, ask one question at a time, and never invent product details.",
    isDefault: true,
  },
  {
    id: 2,
    name: "Arjun — Appointment Assistant",
    role: "appointment assistant",
    description: "A friendly Hinglish booking assistant",
    language: "hinglish",
    voice: "abhilash",
    greeting: "Namaste! Main Arjun hoon. Aaj main aapki kaise help kar sakta hoon?",
    systemPrompt:
      "You are Arjun, a friendly and efficient appointment assistant. Speak natural Hinglish, keep replies brief, ask one question at a time, and confirm dates and times before booking.",
  },
]

const fetcher = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) return DEFAULT_PERSONAS
  const data = await response.json()
  return Array.isArray(data) && data.length > 0 ? data : DEFAULT_PERSONAS
}

const STATE_LABEL: Record<string, string> = {
  idle: "Ready",
  connecting: "Connecting...",
  listening: "Listening — speak now",
  thinking: "Thinking...",
  speaking: "Speaking",
}

function formatTime(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

export function LiveCall() {
  const router = useRouter()
  const { data: personas } = useSWR<Persona[]>("/api/personas", fetcher)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [ending, setEnding] = useState(false)
  const transcriptRef = useRef<HTMLDivElement>(null)

  const {
    state,
    turns,
    level,
    lastLatency,
    error,
    muted,
    toolEvents,
    liveAgentText,
    elapsed,
    start,
    stop,
    toggleMute,
  } = useVoiceAgent()

  const inCall = state !== "idle"
  const selected = personas?.find((p) => p.id === selectedId) || personas?.[0]

  useEffect(() => {
    if (personas && personas.length > 0 && selectedId === null) {
      setSelectedId(personas.find((p) => p.isDefault)?.id ?? personas[0].id)
    }
  }, [personas, selectedId])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" })
  }, [turns, liveAgentText])

  const handleEnd = async () => {
    setEnding(true)
    const id = await stop()
    if (id) router.push(`/calls/${id}`)
    setEnding(false)
  }

  return (
    <div className="flex h-svh flex-col lg:flex-row">
      {/* Left: call stage */}
      <section className="flex flex-1 flex-col items-center justify-center gap-6 border-b border-border p-6 lg:border-b-0 lg:border-r">
        {/* status bar */}
        <div className="flex items-center gap-4">
          <span
            className={cn(
              "flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-medium",
              state === "listening" && "border-primary/40 text-primary",
              state === "speaking" && "border-primary/40 text-primary",
              state === "thinking" && "text-chart-3",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                inCall ? (state === "thinking" ? "bg-chart-3" : "bg-primary") : "bg-muted-foreground",
              )}
            />
            {STATE_LABEL[state]}
          </span>
          {inCall && (
            <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <Clock className="size-3.5" />
              {formatTime(elapsed)}
            </span>
          )}
          {lastLatency !== null && (
            <span
              className={cn(
                "flex items-center gap-1.5 font-mono text-xs",
                lastLatency < 1500 ? "text-chart-2" : lastLatency < 3000 ? "text-chart-3" : "text-destructive",
              )}
              title="Voice-to-voice latency (end of your speech to first agent audio)"
            >
              <Zap className="size-3.5" />
              {(lastLatency / 1000).toFixed(2)}s
            </span>
          )}
        </div>

        <VoiceOrb state={state} level={level} />

        {/* persona picker (pre-call) */}
        {!inCall && (
          <div className="w-full max-w-md">
            <p className="mb-2 text-center text-sm text-muted-foreground">Choose your agent</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(personas || []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    selected?.id === p.id
                      ? "border-primary/60 bg-primary/10"
                      : "border-border bg-card hover:border-muted-foreground/40",
                  )}
                >
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.language === "telugu" ? "Telugu" : "Hinglish"} · {p.role}
                  </p>
                </button>
              ))}
              {!personas && <p className="col-span-2 text-center text-sm text-muted-foreground">Loading agents...</p>}
            </div>
          </div>
        )}

        {error && <p className="max-w-sm text-center text-sm text-destructive">{error}</p>}

        {/* controls */}
        <div className="flex items-center gap-3">
          {!inCall ? (
            <Button
              size="lg"
              className="gap-2 rounded-full px-8"
              disabled={!selected}
              onClick={() => selected && start(selected)}
            >
              <Phone className="size-4" />
              Start Call
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="icon"
                className="size-12 rounded-full bg-transparent"
                onClick={toggleMute}
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              >
                {muted ? <MicOff className="size-5 text-destructive" /> : <Mic className="size-5" />}
              </Button>
              <Button
                variant="destructive"
                size="lg"
                className="gap-2 rounded-full px-8"
                onClick={handleEnd}
                disabled={ending}
              >
                <PhoneOff className="size-4" />
                {ending ? "Ending..." : "End Call"}
              </Button>
            </>
          )}
        </div>

        {!inCall && (
          <p className="max-w-sm text-center text-xs leading-relaxed text-muted-foreground">
            Realistic voice via Sarvam AI, brain via Groq. Speak naturally — the agent detects when you stop. You can
            interrupt it mid-sentence, just like a real call.
          </p>
        )}
      </section>

      {/* Right: live transcript */}
      <section className="flex h-80 w-full flex-col lg:h-auto lg:w-[26rem] xl:w-[30rem]">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="text-sm font-semibold">Live Transcript</h2>
          {inCall && selected && (
            <span className="text-xs text-muted-foreground">
              {selected.name.split("—")[0].trim()} · {selected.language === "telugu" ? "Telugu" : "Hinglish"}
            </span>
          )}
        </header>
        <div ref={transcriptRef} className="flex-1 overflow-y-auto p-4">
          {turns.length === 0 && !liveAgentText ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">Transcript will appear here in real time</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {turns.map((t, i) => (
                <div key={i} className={cn("flex", t.speaker === "user" ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed",
                      t.speaker === "user" ? "bg-primary/15 text-foreground" : "bg-card border border-border",
                    )}
                  >
                    <p className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t.speaker === "user" ? "You" : "Agent"}
                      {t.latencyMs != null && (
                        <span className="flex items-center gap-0.5 font-mono normal-case">
                          <Gauge className="size-2.5" />
                          {(t.latencyMs / 1000).toFixed(2)}s
                        </span>
                      )}
                    </p>
                    {t.content}
                  </div>
                </div>
              ))}
              {liveAgentText && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg border border-primary/30 bg-card px-3 py-2 text-sm leading-relaxed">
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-primary">
                      Agent · speaking
                    </p>
                    {liveAgentText}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {toolEvents.length > 0 && (
          <div className="shrink-0 border-t border-border p-3">
            {toolEvents.slice(-2).map((e, i) => (
              <p key={i} className="flex items-center gap-2 text-xs text-chart-2">
                <CalendarCheck className="size-3.5" />
                Tool executed: {e.name.replace(/_/g, " ")}
              </p>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
