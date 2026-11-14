"use client";
import { useActionState } from "react";
import { login } from "@/app/actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(login, null);
  return (
    <form action={action} className="space-y-3">
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required className="input" defaultValue="landlord@bedley.demo" />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required className="input" defaultValue="demo1234" />
      </div>
      {state?.error && <p className="text-sm text-danger">{state.error}</p>}
      <button className="btn btn-primary w-full justify-center" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
