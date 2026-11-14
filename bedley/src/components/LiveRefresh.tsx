"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Subscribes to /api/stream (MongoDB Change Streams over SSE) and refreshes
 * server components when anything in this org changes. Falls back to polling.
 */
export function LiveRefresh() {
  const router = useRouter();
  const [mode, setMode] = useState<"live" | "polling" | "connecting">("connecting");
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => router.refresh(), 250);
    };
    const es = new EventSource("/api/stream");
    es.onopen = () => setMode("live");
    es.onmessage = refresh;
    es.onerror = () => {
      es.close();
      setMode("polling");
      poll = setInterval(() => router.refresh(), 4000);
    };
    return () => {
      es.close();
      if (poll) clearInterval(poll);
      if (t) clearTimeout(t);
    };
  }, [router]);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-faint" title="Updates via MongoDB Change Streams">
      <span className={`h-1.5 w-1.5 rounded-full ${mode === "live" ? "bg-emerald-accent" : mode === "polling" ? "bg-amber-500" : "bg-stone-300"}`} />
      {mode === "live" ? "Live" : mode === "polling" ? "Polling" : "Connecting"}
    </span>
  );
}
