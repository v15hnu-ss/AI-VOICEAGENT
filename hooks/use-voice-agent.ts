"use client"

import { useCallback, useEffect, useRef, useState } from "react"

export type AgentState = "idle" | "connecting" | "listening" | "thinking" | "speaking"

export interface Turn {
  speaker: "user" | "agent"
  content: string
  latencyMs?: number
}

export interface ToolEvent {
  name: string
  result?: unknown
}

export interface Persona {
  id: number
  name: string
  role: string
  description: string | null
  systemPrompt: string
  language: string
  voice: string
  greeting: string | null
  isDefault?: boolean
}

// --- VAD tuning ---
const SPEECH_START_RMS = 0.022
const SPEECH_START_FRAMES = 3
const SPEECH_END_SILENCE_MS = 850
const MIN_SPEECH_MS = 280
const BARGE_RMS = 0.05
const BARGE_FRAMES = 7

// Sentence boundary for TTS pipelining (Latin, Devanagari danda, Telugu)
const SENTENCE_RE = /([^.!?।॥]*[.!?।॥]+)/

export function useVoiceAgent() {
  const [state, setState] = useState<AgentState>("idle")
  const [turns, setTurns] = useState<Turn[]>([])
  const [level, setLevel] = useState(0)
  const [lastLatency, setLastLatency] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [callId, setCallId] = useState<number | null>(null)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [liveAgentText, setLiveAgentText] = useState("")
  const [elapsed, setElapsed] = useState(0)

  const stateRef = useRef<AgentState>("idle")
  const mutedRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const rafRef = useRef<number>(0)
  const generationRef = useRef(0)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const historyRef = useRef<Array<{ role: string; content: string }>>([])
  const personaRef = useRef<Persona | null>(null)
  const callIdRef = useRef<number | null>(null)
  const latenciesRef = useRef<number[]>([])
  const startTimeRef = useRef<number>(0)
  const speechStartRef = useRef<number>(0)
  const silenceStartRef = useRef<number>(0)
  const speechFramesRef = useRef(0)
  const bargeFramesRef = useRef(0)
  const speakingUserRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const setStateSafe = useCallback((s: AgentState) => {
    stateRef.current = s
    setState(s)
  }, [])

  // ---------- persistence ----------
  const saveTurn = useCallback((speaker: string, content: string, latencyMs?: number) => {
    const id = callIdRef.current
    if (!id || !content.trim()) return
    fetch(`/api/calls/${id}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker, content, latencyMs }),
    }).catch(() => {})
  }, [])

  // ---------- audio playback pipeline ----------
  const stopAllAudio = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current.src = ""
      currentAudioRef.current = null
    }
  }, [])

  const fetchTTS = useCallback(async (text: string, gen: number): Promise<Blob | null> => {
    const persona = personaRef.current
    if (!persona || gen !== generationRef.current) return null
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, language: persona.language, voice: persona.voice }),
      })
      if (!res.ok) return null
      return await res.blob()
    } catch {
      return null
    }
  }, [])

  const playBlob = useCallback(
    (blob: Blob, gen: number): Promise<void> =>
      new Promise((resolve) => {
        if (gen !== generationRef.current) return resolve()
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        currentAudioRef.current = audio
        audio.onended = () => {
          URL.revokeObjectURL(url)
          if (currentAudioRef.current === audio) currentAudioRef.current = null
          resolve()
        }
        audio.onerror = () => {
          URL.revokeObjectURL(url)
          resolve()
        }
        audio.onpause = () => {
          // barge-in pause
          if (audio.ended) return
          URL.revokeObjectURL(url)
          resolve()
        }
        audio.play().catch(() => resolve())
      }),
    [],
  )

  // ---------- recorder ----------
  const startRecorder = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    chunksRef.current = []
    try {
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm"
      const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 })
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.start(250)
      recorderRef.current = rec
    } catch (e) {
      console.error("[v0] recorder error:", e)
    }
  }, [])

  const stopRecorder = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const rec = recorderRef.current
      if (!rec || rec.state === "inactive") return resolve(null)
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType })
        chunksRef.current = []
        resolve(blob.size > 1000 ? blob : null)
      }
      rec.stop()
      recorderRef.current = null
    })
  }, [])

  // ---------- the agent turn: STT -> LLM stream -> TTS pipeline ----------
  const runAgentTurn = useCallback(
    async (audioBlob: Blob) => {
      const gen = ++generationRef.current
      const persona = personaRef.current
      if (!persona) return
      const tUserEnd = performance.now()
      setStateSafe("thinking")
      setLiveAgentText("")

      // 1. STT
      const form = new FormData()
      form.append("audio", audioBlob, "audio.webm")
      form.append("language", persona.language)
      let userText = ""
      try {
        const sttRes = await fetch("/api/stt", { method: "POST", body: form })
        const sttData = await sttRes.json()
        userText = (sttData.text || "").trim()
      } catch {
        // ignore
      }

      if (gen !== generationRef.current) return
      if (!userText || userText.length < 2) {
        // nothing intelligible — go back to listening
        startRecorder()
        setStateSafe("listening")
        return
      }

      setTurns((t) => [...t, { speaker: "user", content: userText }])
      saveTurn("user", userText)
      historyRef.current.push({ role: "user", content: userText })

      // 2. Stream LLM + sentence-level TTS pipelining
      const abort = new AbortController()
      abortRef.current = abort

      let fullText = ""
      let pending = ""
      let firstAudioPlayed = false
      const ttsQueue: Array<Promise<Blob | null>> = []
      let playbackDone: Promise<void> = Promise.resolve()
      let queueIdx = 0

      const enqueueSentence = (sentence: string) => {
        const clean = sentence.trim()
        if (clean.length < 2) return
        // fire TTS fetch immediately (pipelining), play in order
        const blobPromise = fetchTTS(clean, gen)
        ttsQueue.push(blobPromise)
        const myIdx = queueIdx++
        playbackDone = playbackDone.then(async () => {
          if (gen !== generationRef.current) return
          const blob = await ttsQueue[myIdx]
          if (!blob || gen !== generationRef.current) return
          if (!firstAudioPlayed) {
            firstAudioPlayed = true
            const latency = Math.round(performance.now() - tUserEnd)
            setLastLatency(latency)
            latenciesRef.current.push(latency)
            setStateSafe("speaking")
          }
          await playBlob(blob, gen)
        })
      }

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: historyRef.current.slice(-16),
            systemPrompt: persona.systemPrompt,
            callId: callIdRef.current,
          }),
          signal: abort.signal,
        })

        if (!res.body) throw new Error("No stream")
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done || gen !== generationRef.current) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""
          for (const line of lines) {
            if (!line.startsWith("data:")) continue
            try {
              const evt = JSON.parse(line.slice(5).trim())
              if (evt.type === "text") {
                fullText += evt.delta
                pending += evt.delta
                setLiveAgentText(fullText)
                // flush complete sentences to TTS
                let m = pending.match(SENTENCE_RE)
                while (m) {
                  enqueueSentence(m[1])
                  pending = pending.slice(m[0].length)
                  m = pending.match(SENTENCE_RE)
                }
              } else if (evt.type === "tool_result") {
                setToolEvents((t) => [...t, { name: evt.name, result: evt.result }])
              }
            } catch {
              // partial line
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") console.error("[v0] chat stream error:", e)
      }

      if (gen !== generationRef.current) return

      // flush remaining text
      if (pending.trim()) enqueueSentence(pending)

      if (fullText.trim()) {
        historyRef.current.push({ role: "assistant", content: fullText })
        setTurns((t) => [
          ...t,
          {
            speaker: "agent",
            content: fullText,
            latencyMs: latenciesRef.current[latenciesRef.current.length - 1],
          },
        ])
        saveTurn("agent", fullText, latenciesRef.current[latenciesRef.current.length - 1])
      }
      setLiveAgentText("")

      await playbackDone
      if (gen !== generationRef.current) return

      // back to listening
      startRecorder()
      setStateSafe("listening")
    },
    [fetchTTS, playBlob, saveTurn, setStateSafe, startRecorder],
  )

  // ---------- barge-in ----------
  const bargeIn = useCallback(() => {
    generationRef.current++
    abortRef.current?.abort()
    stopAllAudio()
    setLiveAgentText("")
    startRecorder()
    speechStartRef.current = performance.now()
    speakingUserRef.current = true
    silenceStartRef.current = 0
    setStateSafe("listening")
  }, [setStateSafe, startRecorder, stopAllAudio])

  // ---------- VAD loop ----------
  const vadLoop = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return

    const data = new Float32Array(analyser.fftSize)

    const tick = () => {
      if (stateRef.current === "idle") return
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      setLevel(Math.min(1, rms * 12))

      const now = performance.now()
      const s = stateRef.current

      if (!mutedRef.current) {
        if (s === "listening") {
          if (rms > SPEECH_START_RMS) {
            speechFramesRef.current++
            silenceStartRef.current = 0
            if (!speakingUserRef.current && speechFramesRef.current >= SPEECH_START_FRAMES) {
              speakingUserRef.current = true
              speechStartRef.current = now
            }
          } else {
            speechFramesRef.current = 0
            if (speakingUserRef.current) {
              if (silenceStartRef.current === 0) silenceStartRef.current = now
              else if (now - silenceStartRef.current > SPEECH_END_SILENCE_MS) {
                // end of user speech
                speakingUserRef.current = false
                silenceStartRef.current = 0
                const spokeMs = now - speechStartRef.current
                if (spokeMs > MIN_SPEECH_MS) {
                  stopRecorder().then((blob) => {
                    if (blob) runAgentTurn(blob)
                    else {
                      startRecorder()
                    }
                  })
                } // else keep listening
              }
            }
          }
        } else if (s === "speaking") {
          // barge-in detection (higher threshold to reject speaker bleed)
          if (rms > BARGE_RMS) {
            bargeFramesRef.current++
            if (bargeFramesRef.current >= BARGE_FRAMES) {
              bargeFramesRef.current = 0
              bargeIn()
            }
          } else {
            bargeFramesRef.current = 0
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [bargeIn, runAgentTurn, startRecorder, stopRecorder])

  // ---------- start / stop ----------
  const start = useCallback(
    async (persona: Persona) => {
      setError(null)
      setTurns([])
      setToolEvents([])
      latenciesRef.current = []
      historyRef.current = []
      personaRef.current = persona
      setLastLatency(null)
      setStateSafe("connecting")

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        })
        streamRef.current = stream

        const ctx = new AudioContext()
        audioCtxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.5
        source.connect(analyser)
        analyserRef.current = analyser

        // Use persistence when configured; otherwise keep the call session in memory.
        let sessionId = Date.now()
        try {
          const callRes = await fetch("/api/calls", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              personaId: persona.id,
              personaName: persona.name,
              language: persona.language,
            }),
          })
          if (callRes.ok) {
            const call = await callRes.json()
            if (typeof call.id === "number") sessionId = call.id
          }
        } catch {
          // A database is optional for live voice calls.
        }
        callIdRef.current = sessionId
        setCallId(sessionId)
        startTimeRef.current = Date.now()
        setElapsed(0)
        timerRef.current = setInterval(() => {
          setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
        }, 1000)

        vadLoop()

        // speak the greeting
        const gen = ++generationRef.current
        if (persona.greeting) {
          setStateSafe("speaking")
          setTurns([{ speaker: "agent", content: persona.greeting }])
          historyRef.current.push({ role: "assistant", content: persona.greeting })
          saveTurn("agent", persona.greeting)
          const blob = await fetchTTS(persona.greeting, gen)
          if (blob && gen === generationRef.current) {
            await playBlob(blob, gen)
          }
        }
        if (gen === generationRef.current) {
          startRecorder()
          setStateSafe("listening")
        }
      } catch (e) {
        console.error("[v0] start error:", e)
        setError(
          (e as Error).name === "NotAllowedError"
            ? "Microphone access denied. Please allow mic access and try again."
            : "Could not start the call. Check your microphone.",
        )
        setStateSafe("idle")
      }
    },
    [fetchTTS, playBlob, saveTurn, setStateSafe, startRecorder, vadLoop],
  )

  const stop = useCallback(async (): Promise<number | null> => {
    const id = callIdRef.current
    generationRef.current++
    abortRef.current?.abort()
    stopAllAudio()
    cancelAnimationFrame(rafRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop()
      } catch {}
    }
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    setStateSafe("idle")
    setLevel(0)
    setLiveAgentText("")

    if (id) {
      const durationSeconds = Math.floor((Date.now() - startTimeRef.current) / 1000)
      const lat = latenciesRef.current
      const avgLatencyMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null
      const turnCount = historyRef.current.length
      try {
        await fetch(`/api/calls/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "completed", durationSeconds, avgLatencyMs, turnCount }),
        })
        // fire post-call analysis (don't block UI)
        fetch(`/api/calls/${id}/analyze`, { method: "POST" }).catch(() => {})
      } catch {}
    }
    callIdRef.current = null
    return id
  }, [setStateSafe, stopAllAudio])

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      mutedRef.current = !m
      return !m
    })
  }, [])

  useEffect(() => {
    return () => {
      generationRef.current++
      cancelAnimationFrame(rafRef.current)
      if (timerRef.current) clearInterval(timerRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      audioCtxRef.current?.close().catch(() => {})
    }
  }, [])

  return {
    state,
    turns,
    level,
    lastLatency,
    error,
    muted,
    callId,
    toolEvents,
    liveAgentText,
    elapsed,
    start,
    stop,
    toggleMute,
  }
}
