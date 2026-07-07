import { Loader2, LogIn, LogOut, UserRound, UserRoundPlus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { type Me, type Session, api } from "../api.js";

/** Header badge: current identity/role plus the login/logout action. */
export function AuthBadge({
  me,
  onLogin,
  onLogout,
}: {
  me: Me | null;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const anonymous = !me || me.id === "web:anonymous" || me.id === "web:unauthenticated";
  return (
    <div className="flex items-center gap-2">
      <Badge variant={anonymous ? "outline" : "default"} className="gap-1">
        <UserRound className="h-3 w-3" />
        {anonymous ? "anonymous" : me.id.replace(/^user:/, "")}
        {!anonymous && <span className="opacity-70">· {me.role}</span>}
      </Badge>
      {anonymous ? (
        <Button variant="outline" size="sm" onClick={onLogin}>
          <LogIn className="h-4 w-4" /> Login
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={onLogout}>
          <LogOut className="h-4 w-4" /> Logout
        </Button>
      )}
    </div>
  );
}

/** Server error codes → readable messages (register conflicts arrive as 409s). */
const ERROR_TEXT: Record<string, string> = {
  invalid_credentials: "Invalid username or password.",
  username_taken: "That username is already taken.",
  email_taken: "That email is already registered.",
  signup_disabled: "Signup is disabled on this server.",
};

/**
 * Modal auth form with two modes: sign in and create account (self-service signup,
 * P3.5). Reads stay available without it; writes require a session. When the server
 * reports signup disabled (`/api/auth/me` → `signup: false`) the toggle is hidden;
 * a 403 from the register endpoint is also surfaced inline as a fallback.
 */
export function LoginDialog({
  open,
  onClose,
  onLoggedIn,
  signupEnabled = true,
}: {
  open: boolean;
  onClose: () => void;
  onLoggedIn: (session: Session) => void;
  signupEnabled?: boolean;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const registering = mode === "register" && signupEnabled;
  const ready = username.trim() && password && (!registering || email.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const session = registering
        ? await api.register(username.trim(), email.trim(), password)
        : await api.login(username.trim(), password);
      setPassword("");
      onLoggedIn(session);
      onClose();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(ERROR_TEXT[raw] ?? raw);
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m: "login" | "register") => {
    setMode(m);
    setError(null);
  };

  const ModeIcon = registering ? UserRoundPlus : LogIn;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <Card className="w-[22rem] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2">
          <ModeIcon className="h-4 w-4" />
          <h2 className="text-sm font-semibold">{registering ? "Create account" : "Sign in"}</h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          {registering
            ? "The first registered user becomes admin; the rest are regular users."
            : "Writing memory requires an authenticated actor (reads stay open)."}
        </p>
        <Separator className="mb-4" />
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="login-username">username</Label>
            <Input
              id="login-username"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
            />
          </div>
          {registering && (
            <div className="space-y-1.5">
              <Label htmlFor="login-email">email</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="login-password">password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            {registering && <p className="text-xs text-muted-foreground">At least 12 characters.</p>}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="mt-1 flex items-center gap-2">
            <Button type="submit" disabled={busy || !ready}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ModeIcon className="h-4 w-4" />}{" "}
              {registering ? "Create account" : "Sign in"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
          {signupEnabled && (
            <button
              type="button"
              className="mt-1 self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => switchMode(registering ? "login" : "register")}
              disabled={busy}
            >
              {registering ? "Already have an account? Sign in" : "No account? Create one"}
            </button>
          )}
        </form>
      </Card>
    </div>
  );
}
