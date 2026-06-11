"use client";

import { useEffect, useRef } from "react";

const capabilities = [
  {
    title: "Live Screen Context",
    description:
      "Reads the current app window and cursor state so commands can be grounded in what is actually visible.",
    stack: "Cursor overlay, visual routing",
  },
  {
    title: "Adaptive Reasoning",
    description:
      "Routes requests between chat, web answers, local commands, Gmail, Calendar, and guided UI tours.",
    stack: "Groq planning, conversation memory",
  },
  {
    title: "Voice Intelligence",
    description:
      "Listens, answers naturally, and speaks through ElevenLabs with Gemini TTS as the fallback voice.",
    stack: "Speech to text, TTS fallback",
  },
];

export default function Home() {
  const cursorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const cursor = cursorRef.current;

    if (!cursor) {
      return;
    }

    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;
    let followerX = mouseX;
    let followerY = mouseY;
    let animationFrame = 0;

    const onMouseMove = (event: MouseEvent) => {
      mouseX = event.clientX;
      mouseY = event.clientY;
    };

    const animate = () => {
      const dx = mouseX - followerX;
      const dy = mouseY - followerY;

      followerX += dx * 0.13;
      followerY += dy * 0.13;

      const sideOffsetX = 29;
      const sideOffsetY = -20;
      cursor.style.transform = `translate3d(${followerX + sideOffsetX}px, ${followerY + sideOffsetY}px, 0)`;
      animationFrame = window.requestAnimationFrame(animate);
    };

    window.addEventListener("mousemove", onMouseMove);
    animationFrame = window.requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <>
      <div ref={cursorRef} className="triangle-cursor" aria-hidden="true" />
      <main className="relative overflow-hidden bg-[radial-gradient(circle_at_top_right,_#fee2e2,_transparent_40%),radial-gradient(circle_at_bottom_left,_#e0f2fe,_transparent_35%),#0b1017] text-slate-100">
        <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-10 md:px-12">
          <header className="flex items-center justify-between border-b border-white/15 pb-5">
            <p className="text-xs uppercase tracking-[0.24em] text-cyan-200">Desktop Voice System</p>
            <a
              href="#context"
              className="rounded-full border border-cyan-300/60 px-4 py-2 text-xs font-semibold uppercase tracking-[0.15em] transition hover:bg-cyan-300/10"
            >
              System Context
            </a>
          </header>

          <section className="grid flex-1 items-center gap-12 py-14 md:grid-cols-[1.3fr_1fr]">
            <div>
              <p className="mb-4 text-sm uppercase tracking-[0.2em] text-sky-200/90">
                Live Adaptive Reasoning and Voice Intelligence System
              </p>
              <h1 className="max-w-2xl text-4xl font-semibold leading-tight md:text-6xl">
                L.A.R.V.I.S. is your screen-aware voice companion.
              </h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-slate-300">
                He listens, reasons against the current desktop context, and helps execute tasks across apps,
                search, email, calendar, and guided software walkthroughs.
              </p>
              <div className="mt-8 flex flex-wrap gap-3 text-sm">
                <span className="rounded-full bg-white/10 px-4 py-2">Voice-first</span>
                <span className="rounded-full bg-white/10 px-4 py-2">Context-aware</span>
                <span className="rounded-full bg-white/10 px-4 py-2">Tool-connected</span>
                <span className="rounded-full bg-white/10 px-4 py-2">Adaptive</span>
              </div>
            </div>

            <aside className="rounded-3xl border border-white/15 bg-white/5 p-6 backdrop-blur-md">
              <p className="text-xs uppercase tracking-[0.2em] text-cyan-100">Identity</p>
              <ul className="mt-4 space-y-4 text-sm text-slate-200">
                <li>Name: L.A.R.V.I.S.</li>
                <li>Full form: Live Adaptive Reasoning and Voice Intelligence System.</li>
                <li>Role: a warm, capable desktop assistant that understands voice, tools, and on-screen context.</li>
              </ul>
            </aside>
          </section>

          <section id="context" className="pb-14">
            <h2 className="text-2xl font-semibold">Core Context</h2>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {capabilities.map((capability) => (
                <article
                  key={capability.title}
                  className="rounded-2xl border border-white/10 bg-black/25 p-5 transition hover:-translate-y-1 hover:border-cyan-200/60"
                >
                  <h3 className="text-lg font-medium">{capability.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-300">{capability.description}</p>
                  <p className="mt-4 text-xs uppercase tracking-[0.15em] text-cyan-200/80">{capability.stack}</p>
                </article>
              ))}
            </div>
          </section>

          <footer className="border-t border-white/15 pt-6 text-sm text-slate-300">
            <p>L.A.R.V.I.S. stays present as a compact overlay until voice or cursor context calls him forward.</p>
          </footer>
        </div>
      </main>
    </>
  );
}
