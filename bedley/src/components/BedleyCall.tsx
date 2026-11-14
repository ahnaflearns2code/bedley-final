"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { id: string; kind: "briefing" | "approval"; script: string; ticketId: string };
type Line = { who: "bedley" | "you"; text: string };

/**
 * In-app call from Bedley to the landlord: rings, speaks with the ElevenLabs voice,
 * listens with the browser microphone (Chrome speech recognition), and holds a conversation.
 */
export function BedleyCall() {
  const [call, setCall] = useState<Call | null>(null);
  const [phase, setPhase] = useState<"idle" | "ringing" | "speaking" | "listening" | "thinking" | "ended">("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [typed, setTyped] = useState("");
  const ringRef = useRef<{ stop: () => void } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<any>(null);
  const doneRef = useRef(false);
  const seen = useRef<Set<string>>(new Set());

  // Poll for an incoming call
  useEffect(() => {
    if (phase !== "idle") return;
    const tick = async () => {
      try {
        const r = await fetch("/api/calls/pending", { cache: "no-store" });
        const { call } = await r.json();
        if (call && !seen.current.has(call.id)) {
          seen.current.add(call.id);
          setCall(call);
          setLines([]);
          doneRef.current = false;
          setPhase("ringing");
        }
      } catch {
        /* offline */
      }
    };
    void tick();
    const t = setInterval(tick, 2500);
    return () => clearInterval(t);
  }, [phase]);

  // Ringtone
  useEffect(() => {
    if (phase !== "ringing") return;
    let stopped = false;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      const ring = () => {
        if (stopped || !ctx) return;
        for (const [f, at] of [[880, 0], [660, 0.2], [880, 0.4], [660, 0.6]] as const) {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.value = f;
          g.gain.setValueAtTime(0.08, ctx.currentTime + at);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.18);
          o.connect(g).connect(ctx.destination);
          o.start(ctx.currentTime + at);
          o.stop(ctx.currentTime + at + 0.2);
        }
      };
      ring();
      const i = setInterval(ring, 2000);
      ringRef.current = { stop: () => { stopped = true; clearInterval(i); ctx?.close().catch(() => {}); } };
    } catch {
      /* audio blocked until the user clicks — the visual ring still shows */
    }
    return () => ringRef.current?.stop();
  }, [phase]);

  const speak = useCallback(async (text: string) => {
    setPhase("speaking");
    // Never let a voice that doesn't report "ended" freeze the call
    const maxMs = 2000 + text.split(/\s+/).length * 450;
    const guard = <T,>(p: Promise<T>) => Promise.race([p, new Promise<void>((r) => setTimeout(r, maxMs))]);
    setLines((l) => [...l, { who: "bedley", text }]);
    try {
      const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (r.status === 200) {
        const url = URL.createObjectURL(await r.blob());
        const a = new Audio(url);
        audioRef.current = a;
        await guard(
          new Promise<void>((res) => {
            a.onended = () => res();
            a.onerror = () => res();
            a.play().catch(() => res());
          })
        );
        return;
      }
    } catch {
      /* fall through to browser voice */
    }
    await guard(new Promise<void>((res) => {
      if (!("speechSynthesis" in window)) return res();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-CA";
      u.rate = 1.03;
      u.onend = () => res();
      u.onerror = () => res();
      speechSynthesis.speak(u);
    }));
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!call || !text.trim()) return;
      recRef.current?.abort?.();
      setLines((l) => [...l, { who: "you", text }]);
      setPhase("thinking");
      const r = await fetch(`/api/calls/${call.id}/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const { say, done } = await r.json();
      doneRef.current = !!done;
      await speak(say);
      if (done) setPhase("ended");
      else listen();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [call, speak]
  );

  const listen = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setPhase("listening");
    if (!SR) return; // typed / quick replies only
    const rec = new SR();
    rec.lang = "en-CA";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      const text = e.results?.[0]?.[0]?.transcript ?? "";
      if (text) void send(text);
    };
    rec.onerror = () => {};
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }, [send]);

  const answer = async () => {
    if (!call) return;
    ringRef.current?.stop();
    await fetch(`/api/calls/${call.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "answer" }) });
    await speak(call.script);
    listen();
  };
  const decline = async () => {
    if (!call) return;
    ringRef.current?.stop();
    await fetch(`/api/calls/${call.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "decline" }) });
    setPhase("idle");
    setCall(null);
  };
  const hangUp = async () => {
    recRef.current?.abort?.();
    audioRef.current?.pause();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (call && !doneRef.current) await fetch(`/api/calls/${call.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "end" }) });
    setPhase("idle");
    setCall(null);
  };

  if (!call || phase === "idle") return null;

  const quick = call.kind === "approval" ? ["Yes, book them", "How much is it?", "When can they come?", "No, hold off"] : ["How bad is it?", "When will someone come?", "No questions, thanks"];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-line bg-white shadow-2xl">
        <div className="bg-forest px-5 py-5 text-white">
          <div className="flex items-center gap-3">
            <span className="relative grid h-12 w-12 place-items-center rounded-full bg-white text-lg font-bold text-forest">
              B
              {(phase === "ringing" || phase === "speaking") && <span className="absolute inset-0 animate-ping rounded-full bg-white/40" />}
            </span>
            <div>
              <div className="text-lg font-semibold">Bedley</div>
              <div className="text-sm text-white/80">
                {phase === "ringing" ? (call.kind === "approval" ? "Calling you to approve a booking…" : "Calling you about an urgent issue…") : phase === "speaking" ? "Speaking…" : phase === "listening" ? "Listening — go ahead and talk" : phase === "thinking" ? "Thinking…" : "Call ended"}
              </div>
            </div>
          </div>
        </div>

        {phase === "ringing" ? (
          <div className="flex gap-3 p-5">
            <button onClick={decline} className="btn flex-1 justify-center py-2.5">Decline</button>
            <button onClick={answer} className="btn btn-primary flex-1 justify-center py-2.5">Answer</button>
          </div>
        ) : (
          <div className="p-5">
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {lines.map((l, i) => (
                <div key={i} className={`flex ${l.who === "you" ? "justify-end" : ""}`}>
                  <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${l.who === "you" ? "bg-forest text-white" : "bg-stone-100"}`}>{l.text}</div>
                </div>
              ))}
              {phase === "listening" && (
                <div className="flex items-center gap-2 text-xs text-ink-faint">
                  <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" /></span>
                  Microphone on
                </div>
              )}
            </div>
            {phase !== "ended" && (
              <>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {quick.map((q) => (
                    <button key={q} disabled={phase === "speaking" || phase === "thinking"} onClick={() => void send(q)} className="rounded-full border border-line px-3 py-1 text-xs hover:bg-stone-50 disabled:opacity-40">{q}</button>
                  ))}
                </div>
                <form onSubmit={(e) => { e.preventDefault(); const t = typed; setTyped(""); void send(t); }} className="mt-2 flex gap-2">
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} className="input" placeholder="Or type to Bedley…" />
                  <button className="btn">Send</button>
                </form>
              </>
            )}
            <div className="mt-4 flex items-center justify-between">
              <Link href={`/landlord/tickets/${call.ticketId}`} onClick={() => void hangUp()} className="text-xs text-forest hover:underline">Open the request</Link>
              <button onClick={hangUp} className="btn btn-danger">{phase === "ended" ? "Close" : "Hang up"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
