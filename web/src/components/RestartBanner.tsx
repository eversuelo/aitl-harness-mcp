import { Loader2, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../api.js";

/**
 * Pending-restart banner (ADR-0061). Visible to root/admin when the on-disk
 * config (base, .env or active profile) diverges from what the running process
 * booted with — `pending_restart` in /api/config/status lists the key names.
 * "Reiniciar ahora" asks the server for a clean exit-75 shutdown; with
 * `aitl ui --watch-restart` it respawns alone and the page reloads when the
 * health endpoint answers again.
 */
export function RestartBanner({
  canConfig,
  refreshKey,
  onError,
}: {
  canConfig: boolean;
  /** Bump to re-check after config/profile writes. */
  refreshKey: number;
  onError: (e: unknown) => void;
}) {
  const [keys, setKeys] = useState<string[]>([]);
  const [restarting, setRestarting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!canConfig) {
      setKeys([]);
      return;
    }
    api
      .configStatus()
      .then((s) => setKeys(s.pending_restart ?? []))
      .catch(() => setKeys([]));
  }, [canConfig, refreshKey]);

  const restart = async () => {
    setRestarting(true);
    setHint(null);
    try {
      const res = await api.restart();
      if (!res.will_respawn) {
        setHint("El proceso se apagó; relanza `aitl ui` (o usa --watch-restart) — esperando a que vuelva…");
      }
      await api.waitForHealth();
      location.reload();
    } catch (e) {
      onError(e);
      setRestarting(false);
    }
  };

  if (!canConfig || !keys.length) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/15 px-5 py-2 text-sm text-amber-700 dark:text-amber-400">
      <span>
        Reinicio pendiente — cambios en <code className="font-mono text-xs">{keys.join(", ")}</code> aplican al
        reiniciar el proceso.
        {hint && <em className="ml-2 text-xs">{hint}</em>}
      </span>
      <Button size="sm" variant="outline" onClick={() => void restart()} disabled={restarting}>
        {restarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />} Reiniciar
        ahora
      </Button>
    </div>
  );
}
