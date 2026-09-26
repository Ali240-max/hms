import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Eye,
  EyeOff,
  LogIn,
  ShieldCheck,
  Banknote,
  FileBarChart,
  FlaskConical,
  WifiOff,
} from "lucide-react";
import { api, setToken, type SessionUser } from "../lib/api";
import { ErrorNote } from "../components/ui";
import { t as tr } from "../lib/prefs";
import { EASE } from "../lib/motion";
import mark from "../assets/northbyte-mark.png";

/**
 * Signing in.
 *
 * The department buttons are gone. A grid of them told anybody standing at an
 * unattended counter exactly which departments exist, how many there are and
 * what each is called, and it bought nothing: a username already knows which
 * department it belongs to. Whoever types their own name gets their own
 * screen.
 *
 * Two columns, the hospital's panel on the left and the form on the right. On
 * a phone the panel becomes a short header, because a sign-in screen that
 * makes somebody scroll past artwork to reach the password field was designed
 * for a screenshot rather than for a morning shift.
 */

/** Drawn rather than dropped in as an image, so they scale and follow the theme. */
const RINGS = [
  { size: 460, opacity: 0.1, delay: 0 },
  { size: 360, opacity: 0.14, delay: 0.08 },
  { size: 260, opacity: 0.18, delay: 0.16 },
  { size: 170, opacity: 0.24, delay: 0.24 },
];

/** Each point gets its own mark. Four bullet dots in a column read as filler. */
const POINTS = [
  {
    icon: Banknote,
    title: "Every rupee accounted for",
    line: "Traced to the counter that took it",
  },
  {
    icon: FlaskConical,
    title: "Lab and radiology built in",
    line: "Reference ranges and formulas included",
  },
  {
    icon: FileBarChart,
    title: "Reports for every department",
    line: "On screen, or as a PDF to keep",
  },
  {
    icon: WifiOff,
    title: "Runs on the hospital's own server",
    line: "Keeps working when the internet does not",
  },
];

export function SignIn({
  onSignedIn,
}: {
  onSignedIn: (u: SessionUser) => void;
}) {
  const [mode, setMode] = useState<"loading" | "login" | "setup">("loading");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .authStatus()
      .then((st) => setMode(st.needsSetup ? "setup" : "login"))
      .catch(() => setMode("login"));
  }, []);

  useEffect(() => {
    if (mode !== "loading") first.current?.focus();
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setErr(tr("Enter your username and password"));
      return;
    }
    if (mode === "setup" && password !== confirm) {
      setErr(tr("The two passwords do not match"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r =
        mode === "setup"
          ? await api.setup({
              username: username.trim(),
              displayName: displayName.trim() || username.trim(),
              password,
            })
          : await api.login(username.trim(), password);
      setToken(r.token);
      onSignedIn(r.user);
    } catch (e: any) {
      setErr(e.message ?? tr("That did not work"));
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-auto bg-screen lg:grid-cols-[1.05fr_1fr]">
      {/* ------------------------------------------------------ the panel */}
      <aside
        className="relative flex min-h-[220px] flex-col justify-between overflow-hidden
                        px-8 py-8 text-white lg:min-h-0 lg:px-14 lg:py-12"
        style={{
          backgroundImage:
            "linear-gradient(145deg, rgb(var(--c-heading)) 0%, rgb(var(--c-primary)) 58%," +
            " rgb(var(--c-accent)) 135%)",
        }}
      >
        {/*
          Rings that assemble as the page loads, with a monitor trace through
          them. SVG, so it stays crisp on a 4K counter screen and costs
          nothing to download.
        */}
        <svg
          className="pointer-events-none absolute -right-28 -top-28 h-[580px] w-[580px]
                        lg:-right-20"
          viewBox="0 0 560 560"
          fill="none"
          aria-hidden
        >
          {RINGS.map((r, i) => (
            <motion.circle
              key={r.size}
              cx="280"
              cy="280"
              r={r.size / 2}
              stroke="white"
              strokeWidth={i === 3 ? 26 : 18}
              strokeOpacity={r.opacity}
              fill="none"
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 1.1, delay: r.delay, ease: EASE }}
              style={{ transformOrigin: "280px 280px" }}
            />
          ))}
          <motion.path
            d="M20 300 H140 L164 244 L196 356 L226 262 L248 300 H320"
            stroke="white"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity="0.5"
            fill="none"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.6, delay: 0.35, ease: EASE }}
          />
        </svg>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="relative"
        >
          <span
            className="inline-flex items-center gap-2 rounded-full border border-white/25
                           bg-white/10 px-3 py-1 text-2xs backdrop-blur-sm"
          >
            <ShieldCheck size={13} /> {tr("Hospital Management System")}
          </span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2, ease: EASE }}
          className="relative my-6 max-w-lg lg:my-0"
        >
          <h1 className="text-3xl font-bold leading-tight lg:text-[2.6rem]">
            {tr("One counter, one record,")}
            <br className="hidden lg:block" />{" "}
            <span className="text-white/75">
              {tr("from the front desk to the ward.")}
            </span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-white/70">
            {tr(
              "Registration, billing, laboratory, radiology, pharmacy and stores, on one server the hospital owns."
            )}
          </p>

          <ul className="mt-8 hidden gap-x-6 gap-y-3 lg:grid lg:grid-cols-2">
            {POINTS.map((p, i) => {
              const Icon = p.icon;
              return (
                <motion.li
                  key={p.title}
                  className="flex items-start gap-3 rounded-xl border border-white/15
                             bg-white/[0.07] px-3.5 py-3 backdrop-blur-sm"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    duration: 0.45,
                    delay: 0.35 + i * 0.07,
                    ease: EASE,
                  }}
                >
                  <span
                    className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg
                                   bg-white/15 text-white"
                  >
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-2xs font-semibold text-white">
                      {tr(p.title)}
                    </span>
                    <span className="mt-0.5 block text-[0.7rem] leading-snug text-white/65">
                      {tr(p.line)}
                    </span>
                  </span>
                </motion.li>
              );
            })}
          </ul>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.6, ease: EASE }}
          className="relative flex items-center gap-4 rounded-2xl border border-white/15
                     bg-white/[0.07] px-4 py-3.5 backdrop-blur-sm"
        >
          {/*
            On a white tile, in its own colours.
            The mark is mostly mid-tone teal and navy. Flattened to a white
            silhouette it all but vanished against this gradient, and a logo
            nobody can read is not a logo.
          */}
          <span
            className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-white
                           p-2 shadow-lg "
          >
            <img
              src={mark}
              alt="NorthByte Technologies"
              className="h-full w-full mb-3"
            />
          </span>
          <span className="leading-tight">
            <span className="block text-[0.7rem] uppercase tracking-wider text-white/55">
              {tr("Developed by")}
            </span>
            <span className="block text-base font-semibold text-white">
              NorthByte Technologies
            </span>
            <span className="mt-0.5 block text-[0.7rem] text-white/55">
              {tr("Licensed to this hospital")} · v1.0
            </span>
          </span>
        </motion.div>
      </aside>

      {/* ------------------------------------------------------- the form */}
      <main className="flex items-center justify-center px-6 py-10 lg:px-12">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15, ease: EASE }}
          className="w-full max-w-sm"
        >
          <h2 className="text-2xl font-semibold text-heading">
            {mode === "setup" ? tr("Set up the first account") : tr("Sign in")}
          </h2>
          <p className="mt-1.5 text-2xs text-muted">
            {mode === "setup"
              ? tr(
                  "This one is the administrator. Everybody else is added afterwards."
                )
              : tr("Use the username the hospital gave you.")}
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <label className="block">
              <span className="label">{tr("Username")}</span>
              <input
                ref={first}
                value={username}
                autoComplete="username"
                onChange={(e) => setUsername(e.target.value)}
                className="field mt-1.5 py-2.5"
              />
            </label>

            {mode === "setup" && (
              <label className="block">
                <span className="label">{tr("Your name")}</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="field mt-1.5 py-2.5"
                  placeholder={tr("Printed on everything you do")}
                />
              </label>
            )}

            <label className="block">
              <span className="label">{tr("Password")}</span>
              <div className="relative mt-1.5">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  autoComplete={
                    mode === "setup" ? "new-password" : "current-password"
                  }
                  onChange={(e) => setPassword(e.target.value)}
                  className="field py-2.5 pr-11"
                />
                {/*
                  Off until asked for: a counter screen is usually in view of a
                  queue.
                */}
                <button
                  type="button"
                  onClick={() => setShow((v) => !v)}
                  aria-label={show ? tr("Hide password") : tr("Show password")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted
                             transition-colors hover:text-primary"
                >
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            {mode === "setup" && (
              <label className="block">
                <span className="label">{tr("Password again")}</span>
                <input
                  type="password"
                  value={confirm}
                  autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)}
                  className="field mt-1.5 py-2.5"
                />
              </label>
            )}

            <ErrorNote>{err}</ErrorNote>

            <button
              type="submit"
              disabled={busy || mode === "loading"}
              className="btn-primary flex w-full items-center justify-center gap-2 py-2.5"
            >
              <LogIn size={16} />
              {busy
                ? tr("Signing in…")
                : mode === "setup"
                ? tr("Create the account")
                : tr("Sign in")}
            </button>
          </form>

          <p className="mt-6 text-2xs leading-relaxed text-muted">
            {tr(
              "Forgotten your password? An administrator can reset it under Administration, Staff. Nobody can read the old one, including them."
            )}
          </p>
        </motion.div>
      </main>
    </div>
  );
}
