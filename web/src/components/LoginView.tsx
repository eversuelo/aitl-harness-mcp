import { Loader2, LogIn, LogOut, UserRound } from "lucide-react";
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

/** Modal login form. Reads stay available without it; writes require a session. */
export function LoginDialog({
  open,
  onClose,
  onLoggedIn,
}: {
  open: boolean;
  onClose: () => void;
  onLoggedIn: (session: Session) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(username.trim(), password);
      setPassword("");
      onLoggedIn(session);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <Card className="w-[22rem] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2">
          <LogIn className="h-4 w-4" />
          <h2 className="text-sm font-semibold">Sign in</h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Writing memory requires an authenticated actor (reads stay open).
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
          <div className="space-y-1.5">
            <Label htmlFor="login-password">password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="mt-1 flex items-center gap-2">
            <Button type="submit" disabled={busy || !username.trim() || !password}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Sign in
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
