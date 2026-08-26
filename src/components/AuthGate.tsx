"use client";

import { FormEvent, ReactNode, useState } from "react";
import { authClient } from "@/lib-auth";

type Mode = "sign-in" | "sign-up";

export default function AuthGate({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (mode === "sign-up" && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    setBusy(true);
    try {
      const result = mode === "sign-up"
        ? await authClient.signUp.email({ name: name.trim() || email.split("@")[0], email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result?.error) setError(result.error.message || "Authentication failed.");
    } catch (cause) {
      console.error("Neon Auth request failed", cause);
      setError("Could not connect to authentication. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (session.isPending) {
    return <div className="auth-loading"><div className="auth-spinner"/><b>Opening StudyOS…</b></div>;
  }

  if (session.data?.user) return <>{children}</>;

  return (
    <main className="auth-page">
      <section className="auth-showcase">
        <div className="auth-logo"><span>S</span><b>StudyOS</b></div>
        <div className="auth-copy">
          <span className="eyebrow">YOUR AI STUDY SYSTEM</span>
          <h1>Turn your notes into<br/>measurable mastery.</h1>
          <p>Upload your course material and study with an AI tutor, summaries, flashcards, exams and transparent progress analytics.</p>
          <div className="auth-features">
            <span>✦ Source-grounded AI Tutor</span>
            <span>◫ Smart flashcards</span>
            <span>✓ Exam simulations</span>
            <span>↗ Mastery & readiness tracking</span>
          </div>
        </div>
        <small>Private beta · Your study data stays tied to your account.</small>
      </section>

      <section className="auth-panel-wrap">
        <form className="auth-panel" onSubmit={submit}>
          <div className="auth-panel-head">
            <span>{mode === "sign-up" ? "CREATE ACCOUNT" : "WELCOME BACK"}</span>
            <h2>{mode === "sign-up" ? "Start studying smarter" : "Sign in to StudyOS"}</h2>
            <p>{mode === "sign-up" ? "Create your private study workspace." : "Continue where you left off."}</p>
          </div>

          {mode === "sign-up" && <label>Full name<input autoComplete="name" value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" required /></label>}
          <label>Email<input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required /></label>
          <label>Password<input type="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters" required /></label>
          {mode === "sign-up" && <label>Confirm password<input type="password" autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="Repeat password" required /></label>}

          {error && <div className="auth-error">{error}</div>}
          <button className="auth-submit" disabled={busy}>{busy ? "Please wait…" : mode === "sign-up" ? "Create account" : "Sign in"}<span>→</span></button>

          <div className="auth-switch">
            {mode === "sign-up" ? "Already have an account?" : "New to StudyOS?"}
            <button type="button" onClick={()=>{setMode(mode === "sign-up" ? "sign-in" : "sign-up");setError("")}}>{mode === "sign-up" ? "Sign in" : "Create account"}</button>
          </div>
        </form>
      </section>
    </main>
  );
}
