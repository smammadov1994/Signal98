"use client";
import { useState, useEffect } from "react";
import { identify, reset, capture, getDistinctId } from "signal98";

const PEOPLE = [
  { id: "ada@example.com", name: "Ada Lovelace", plan: "pro" },
  { id: "grace@example.com", name: "Grace Hopper", plan: "team" },
  { id: "linus@example.com", name: "Linus T.", plan: "free" },
];

export default function Account() {
  const [who, setWho] = useState(null);
  const [anon, setAnon] = useState(""); // read after mount: the id only exists in the browser
  useEffect(() => { setWho(localStorage.getItem("ghostmart_user")); setAnon(getDistinctId() || ""); }, []);

  const login = (p) => {
    identify(p.id, { name: p.name, email: p.id, plan: p.plan }, { first_shop: "ghost-mart" });
    capture("user_logged_in", { plan: p.plan });
    localStorage.setItem("ghostmart_user", p.id);
    setWho(p.id);
  };
  const logout = () => {
    capture("user_logged_out");
    reset();
    localStorage.removeItem("ghostmart_user");
    setWho(null);
  };

  return (
    <div className="card wide">
      <h1>Account</h1>
      {who ? (
        <>
          <p className="blurb">Signed in as <b>{who}</b>. Your earlier anonymous activity is now attached to this person in the monitor.</p>
          <button className="btn ghost" onClick={logout}>Log out</button>
        </>
      ) : (
        <>
          <p className="blurb">Pick someone to log in as — this calls <code>identify()</code>.</p>
          {PEOPLE.map((p) => <button key={p.id} className="btn ghost block" onClick={() => login(p)}>{p.name} · {p.plan}</button>)}
          <p className="hint">anonymous id: {anon}</p>
        </>
      )}
    </div>
  );
}
