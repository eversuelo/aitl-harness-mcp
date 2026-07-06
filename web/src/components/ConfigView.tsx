import { Check, Loader2, RefreshCw, Save, Settings2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { type ConfigStatus, api } from "../api.js";

/**
 * Harness config panel (P3.5). Root/admin only (the App gates the tab by role;
 * the server enforces it via RBAC `config_secrets`). Saving PUTs only the keys
 * the user actually typed; the server mirrors them into ~/.aitl/config.json AND
 * the project `.env`.
 */

interface FieldSpec {
  key: string;
  secret?: boolean;
  hint?: string;
}

const FIELDS: FieldSpec[] = [
  { key: "AITL_API_KEY", secret: true, hint: "clave única, clasificada por prefijo (sk-ant-* / sk-or-*)" },
  { key: "MODEL_PRIMARY", hint: "anthropic | openrouter | lmstudio | openai-compat | auto" },
  { key: "OPENROUTER_API_KEY", secret: true },
  { key: "LMSTUDIO_BASE_URL", hint: "http://localhost:1234/v1" },
  { key: "LMSTUDIO_MODEL" },
  { key: "OPENAI_COMPAT_BASE_URL", hint: "Ollama /v1, vLLM, LiteLLM…" },
  { key: "OPENAI_COMPAT_MODEL" },
  { key: "EMBEDDING_PROVIDER", hint: "local | voyage" },
  { key: "EMBEDDING_MODEL" },
  { key: "AITL_WEB_ORIGINS", hint: "CSV de orígenes CORS permitidos" },
];

export function ConfigView({ onError }: { onError: (e: unknown) => void }) {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.configStatus());
      onError(null);
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (key: string, value: string) => {
    setSaved(null);
    setDraft((d) => {
      const next = { ...d };
      if (value === "") delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const dirty = Object.keys(draft);

  const save = async () => {
    if (!dirty.length) return;
    setSaving(true);
    setSaved(null);
    try {
      await api.updateConfig(draft);
      setDraft({});
      setSaved(`Guardado: ${dirty.join(", ")} (perfil + .env)`);
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  const providers = status?.providers;

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <div className="mb-4 flex items-center gap-2">
        <Settings2 className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Configuración del harness</h2>
        <Button variant="outline" size="icon" className="ml-auto" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      {/* ── Estado ── */}
      <Card className="mb-5 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Estado</h3>
          {status && (
            <Badge variant={status.signup_enabled ? "default" : "secondary"} className="ml-auto">
              signup {status.signup_enabled ? "on" : "off"}
            </Badge>
          )}
        </div>
        {providers ? (
          <>
            <div className="flex flex-col gap-2">
              {providers.providers.map((p) => (
                <div key={p.name} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={p.configured ? "default" : "outline"} className="w-32 justify-center font-mono">
                    {p.name}
                  </Badge>
                  <span className={p.configured ? "" : "text-muted-foreground"}>
                    {p.configured ? "configurado" : "sin configurar"}
                  </span>
                  {p.name === providers.active && <Badge variant="secondary">activo</Badge>}
                  <span className="ml-auto truncate font-mono text-xs text-muted-foreground" title={p.via}>
                    {p.model}
                  </span>
                </div>
              ))}
            </div>
            <Separator className="my-3" />
            <p className="text-xs text-muted-foreground">
              cadena de fallback:{" "}
              {providers.active
                ? [providers.active, ...providers.fallbacks].join(" → ")
                : "(ningún backend configurado)"}
              {providers.aitl_api_key && ` · AITL_API_KEY → ${providers.aitl_api_key}`}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{loading ? "Cargando…" : "Sin datos (¿permisos?)."}</p>
        )}
      </Card>

      {/* ── Claves ── */}
      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold">Claves</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          Solo se envían los campos que cambies. Se persiste en ~/.aitl/config.json y se espeja al .env del
          proyecto. Los secretos se muestran enmascarados.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`cfg-${f.key}`} className="font-mono text-xs">
                {f.key}
              </Label>
              <Input
                id={`cfg-${f.key}`}
                type={f.secret ? "password" : "text"}
                value={draft[f.key] ?? ""}
                onChange={(e) => edit(f.key, e.target.value)}
                placeholder={status?.profile[f.key] ?? "(sin definir)"}
                autoComplete="off"
                disabled={saving}
                className={draft[f.key] !== undefined ? "border-primary" : ""}
              />
              {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
            </div>
          ))}
        </div>
        <Separator className="my-4" />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={saving || !dirty.length}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Guardar
            {dirty.length > 0 && ` (${dirty.length})`}
          </Button>
          {dirty.length > 0 && (
            <Button variant="outline" onClick={() => setDraft({})} disabled={saving}>
              Descartar cambios
            </Button>
          )}
          {saved && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="h-3.5 w-3.5" /> {saved}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
