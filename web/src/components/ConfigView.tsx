import { Check, Loader2, Plus, RefreshCw, Save, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { type ConfigStatus, type ProfilesInfo, api } from "../api.js";

/**
 * Harness config panel (P3.5 + ADR-0061). Root/admin only (the App gates the tab
 * by role; the server enforces it via RBAC `config_secrets`). Saving PUTs only
 * the keys the user actually typed; the server mirrors them into
 * ~/.aitl/config.json AND the project `.env`. The "Perfiles" card manages the
 * named overlays (~/.aitl/profiles/<name>.json) — activating one applies on the
 * next restart (the App shows the pending-restart banner).
 */

interface FieldSpec {
  key: string;
  secret?: boolean;
  hint?: string;
}

interface FieldGroup {
  title: string;
  fields: FieldSpec[];
}

/** Full ENV_KEYS catalog, grouped — parity with `aitl config set` (ADR-0061). */
const FIELD_GROUPS: FieldGroup[] = [
  {
    title: "Conexión / BD",
    fields: [
      { key: "MONGODB_URI", hint: "mongodb+srv://… (credenciales enmascaradas al mostrar)" },
      { key: "MONGODB_URI_FALLBACK", hint: "URI alterno si el primario no responde" },
      { key: "MONGODB_DB", hint: "nombre de la base (default: aitl)" },
    ],
  },
  {
    title: "Modelos / Proveedores",
    fields: [
      { key: "MODEL_PRIMARY", hint: "anthropic | openrouter | lmstudio | openai-compat | auto" },
      { key: "MODEL_SECONDARY" },
      { key: "MODEL_HOST", hint: "host delegado: codex | claude-code | antigravity" },
      { key: "AITL_API_KEY", secret: true, hint: "clave única, clasificada por prefijo (sk-ant-* / sk-or-*)" },
      { key: "ANTHROPIC_API_KEY", secret: true },
      { key: "ANTHROPIC_MODEL" },
      { key: "ANTHROPIC_MAX_CONTEXT" },
      { key: "OPENROUTER_API_KEY", secret: true },
      { key: "OPENROUTER_MODEL" },
      { key: "LMSTUDIO_BASE_URL", hint: "http://localhost:1234/v1" },
      { key: "LMSTUDIO_MODEL" },
      { key: "LMSTUDIO_API_KEY", secret: true },
      { key: "LMSTUDIO_MAX_CONTEXT" },
      { key: "OPENAI_COMPAT_BASE_URL", hint: "Ollama /v1, vLLM, LiteLLM…" },
      { key: "OPENAI_COMPAT_MODEL" },
      { key: "OPENAI_COMPAT_API_KEY", secret: true },
      { key: "OPENAI_COMPAT_MAX_CONTEXT" },
    ],
  },
  {
    title: "Embeddings",
    fields: [
      { key: "EMBEDDING_PROVIDER", hint: "local | voyage" },
      { key: "EMBEDDING_MODEL" },
      { key: "EMBEDDING_DIMS", hint: "debe casar con el índice vectorial (384 MiniLM / 1024 voyage)" },
      { key: "VOYAGE_API_KEY", secret: true },
    ],
  },
  {
    title: "Memoria",
    fields: [
      { key: "MEMORY_MAX_DOCS", hint: "gatillo de síntesis por proyecto" },
      { key: "MEMORY_MAX_TOKENS" },
      { key: "ENABLED_ADAPTERS", hint: "CSV (default: agents_md)" },
    ],
  },
  {
    title: "Bootstrap (usuario semilla)",
    fields: [
      { key: "AITL_BOOTSTRAP_USERNAME" },
      { key: "AITL_BOOTSTRAP_EMAIL" },
      { key: "AITL_BOOTSTRAP_PASSWORD", secret: true },
      { key: "AITL_BOOTSTRAP_ROLE", hint: "default: root" },
      { key: "AITL_BOOTSTRAP_AUTOGEN", hint: "false desactiva el root local autogenerado" },
    ],
  },
  {
    title: "Web",
    fields: [
      { key: "AITL_WEB_ORIGINS", hint: "CSV de orígenes CORS permitidos" },
      { key: "AITL_WEB_ALLOW_SIGNUP", hint: "false apaga el registro self-service" },
    ],
  },
];

/** Human hint for the provenance of a key's effective value. */
const SOURCE_LABEL: Record<string, string> = {
  env: "env real (eclipsa perfil y archivo)",
  profile: "perfil activo",
  dotenv: ".env del proyecto",
  file: "config.json",
};

export function ConfigView({
  onError,
  onConfigChanged,
}: {
  onError: (e: unknown) => void;
  /** Bumps the App-level pending-restart banner after any config/profile write. */
  onConfigChanged?: () => void;
}) {
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
      onConfigChanged?.();
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
          {status?.mongo && (
            <Badge variant={status.mongo.ok ? "default" : "destructive"}>
              mongo {status.mongo.ok ? `ok (${status.mongo.db ?? "?"})` : "sin conexión"}
            </Badge>
          )}
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

      {/* ── Perfiles (ADR-0061) ── */}
      <ProfilesCard
        status={status}
        onError={onError}
        onChanged={async () => {
          await load();
          onConfigChanged?.();
        }}
      />

      {/* ── Claves ── */}
      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold">Claves</h3>
        <p className="mb-4 text-xs text-muted-foreground">
          Solo se envían los campos que cambies. Se persiste en ~/.aitl/config.json y se espeja al .env del
          proyecto. Los secretos se muestran enmascarados. Los cambios de conexión aplican al reiniciar
          (banner arriba).
        </p>
        {FIELD_GROUPS.map((group, gi) => (
          <div key={group.title}>
            {gi > 0 && <Separator className="my-4" />}
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title}
            </h4>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {group.fields.map((f) => {
                const source = status?.sources?.[f.key];
                return (
                  <div key={f.key} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`cfg-${f.key}`} className="font-mono text-xs">
                        {f.key}
                      </Label>
                      {source === "env" && (
                        <Badge
                          variant="outline"
                          className="h-4 px-1 text-[10px]"
                          title={SOURCE_LABEL[source]}
                        >
                          env
                        </Badge>
                      )}
                      {source === "profile" && (
                        <Badge
                          variant="secondary"
                          className="h-4 px-1 text-[10px]"
                          title={SOURCE_LABEL[source]}
                        >
                          perfil
                        </Badge>
                      )}
                    </div>
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
                );
              })}
            </div>
          </div>
        ))}
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

/* ── Perfiles con nombre: crear / editar claves / activar / borrar ─────────── */

function ProfilesCard({
  status,
  onError,
  onChanged,
}: {
  status: ConfigStatus | null;
  onError: (e: unknown) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [info, setInfo] = useState<ProfilesInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [keyDraft, setKeyDraft] = useState<{ key: string; value: string }>({ key: "MONGODB_DB", value: "" });
  const [busy, setBusy] = useState(false);

  const ALL_KEYS = FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

  const load = useCallback(async () => {
    try {
      const next = await api.profiles();
      setInfo(next);
      setSelected((s) => (s && next.profiles.some((p) => p.name === s) ? s : (next.profiles[0]?.name ?? null)));
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) return setView({});
    api
      .profile(selected)
      .then(setView)
      .catch((e) => onError(e));
  }, [selected, onError]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      if (selected) setView(await api.profile(selected).catch(() => ({})));
      await onChanged();
      onError(null);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const active = info?.active ?? null;

  return (
    <Card className="mb-5 p-4">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-sm font-semibold">Perfiles</h3>
        {active ? <Badge>activo: {active}</Badge> : <Badge variant="outline">sin perfil activo</Badge>}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Un perfil (trabajo/personal…) solo pisa las claves que define — típicamente MONGODB_URI/MONGODB_DB —
        y hereda el resto de la config base. Activarlo aplica <b>al reiniciar</b> el proceso.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(info?.profiles ?? []).map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => setSelected(p.name)}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors ${
              selected === p.name ? "border-primary bg-primary/10" : "hover:bg-accent"
            }`}
            title={p.keys.join(", ") || "(vacío)"}
          >
            {p.active ? "★ " : ""}
            {p.name}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="nuevo-perfil"
            className="h-7 w-36 font-mono text-xs"
            disabled={busy}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !newName.trim()}
            onClick={() =>
              void run(async () => {
                await api.saveProfile(newName.trim(), {});
                setSelected(newName.trim());
                setNewName("");
              })
            }
          >
            <Plus className="h-3.5 w-3.5" /> Crear
          </Button>
        </div>
      </div>

      {selected && (
        <div className="rounded-md border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold">{selected}</span>
            {selected === active ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.activateProfile(null))}>
                Desactivar
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void run(() => api.activateProfile(selected))}>
                Activar
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              className="ml-auto"
              disabled={busy || selected === active}
              title={selected === active ? "Desactívalo antes de borrarlo" : undefined}
              onClick={() => {
                if (!confirm(`¿Borrar el perfil "${selected}"?`)) return;
                void run(async () => {
                  await api.deleteProfile(selected);
                  setSelected(null);
                });
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          {Object.keys(view).length ? (
            <div className="mb-2 flex flex-col gap-1">
              {Object.entries(view).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <span className="w-56 shrink-0 font-mono">{k}</span>
                  <span className="truncate font-mono text-muted-foreground">{v}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto h-5 w-5"
                    disabled={busy}
                    title="Quitar esta clave del perfil"
                    onClick={() => void run(() => api.saveProfile(selected, { [k]: null }))}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-2 text-xs text-muted-foreground">(perfil vacío — añade claves abajo)</p>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <Select value={keyDraft.key} onValueChange={(key) => setKeyDraft((d) => ({ ...d, key }))}>
              <SelectTrigger className="h-7 w-56 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_KEYS.map((k) => (
                  <SelectItem key={k} value={k} className="font-mono text-xs">
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={keyDraft.value}
              onChange={(e) => setKeyDraft((d) => ({ ...d, value: e.target.value }))}
              placeholder="valor"
              className="h-7 w-56 font-mono text-xs"
              disabled={busy}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !keyDraft.value}
              onClick={() =>
                void run(async () => {
                  await api.saveProfile(selected, { [keyDraft.key]: keyDraft.value });
                  setKeyDraft((d) => ({ ...d, value: "" }));
                })
              }
            >
              <Save className="h-3.5 w-3.5" /> Set
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
