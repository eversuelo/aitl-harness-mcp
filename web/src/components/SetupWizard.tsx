import { ArrowRight, Check, Database, Loader2, RotateCw, ShieldCheck, User } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { type DbInitReport, type SetupStatus, api } from "../api.js";

/**
 * First-boot wizard (ADR-0061). Shown while the server reports `setup_required`:
 *   0. Conexión  — only when Mongo is unreachable (fix URI → guided restart);
 *   1. Root      — create THE root account (the wizard continues authenticated);
 *   2. Proveedor — optional quick model/key config (PUT /api/config as root);
 *   3. Resumen   — init-db + enter the app.
 * The unauthenticated surface is loopback-only; from another host the wizard
 * shows instructions instead.
 */

type LocalStep = "root" | "providers" | "summary";

export function SetupWizard({
  status,
  onDone,
  onError,
}: {
  status: SetupStatus;
  /** Called when the wizard finishes (App refreshes /api/auth/me + setup status). */
  onDone: () => void;
  onError: (e: unknown) => void;
}) {
  const [step, setStep] = useState<LocalStep>("root");

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-lg">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">AITL · Primer arranque</h1>
            <p className="text-xs text-muted-foreground">
              {status.mongo.ok
                ? `mongo ok (${status.mongo.db ?? "?"}) · sin usuarios todavía`
                : "sin conexión a MongoDB"}
            </p>
          </div>
        </div>

        {!status.loopback ? (
          <Card className="p-5 text-sm">
            <p className="mb-2 font-medium">Setup restringido a localhost</p>
            <p className="text-muted-foreground">
              Este servidor está en modo de primer arranque, pero la configuración inicial solo se permite
              desde la propia máquina (loopback). Abre la UI en{" "}
              <code className="font-mono">http://localhost</code> donde corre <code>aitl ui</code>, o crea el
              root por CLI: <code className="font-mono">aitl user register</code>.
            </p>
          </Card>
        ) : !status.mongo.ok ? (
          <ConnectionStep status={status} onError={onError} />
        ) : step === "root" ? (
          <RootStep onError={onError} onCreated={() => setStep("providers")} />
        ) : step === "providers" ? (
          <ProvidersStep onError={onError} onNext={() => setStep("summary")} />
        ) : (
          <SummaryStep onError={onError} onDone={onDone} />
        )}
      </div>
    </div>
  );
}

/* ── Paso 0: conexión (solo con Mongo caído) ───────────────────────────────── */

function ConnectionStep({ status, onError }: { status: SetupStatus; onError: (e: unknown) => void }) {
  const [uri, setUri] = useState("");
  const [db, setDb] = useState("aitl");
  const [probe, setProbe] = useState<{ ok: boolean; error?: string } | null>(null);
  const [savedKeys, setSavedKeys] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<"probe" | "save" | "restart" | null>(null);

  const test = async () => {
    setBusy("probe");
    setProbe(null);
    try {
      setProbe(await api.setupTestConnection(uri.trim(), db.trim() || undefined));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      const res = await api.setupConnection({
        MONGODB_URI: uri.trim(),
        ...(db.trim() ? { MONGODB_DB: db.trim() } : {}),
      });
      setSavedKeys(res.keys);
      onError(null);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    setBusy("restart");
    try {
      await api.restart();
      await api.waitForHealth();
      location.reload(); // fresh boot picks the new URI; the wizard resumes at Root
    } catch (e) {
      onError(e);
      setBusy(null);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Database className="h-4 w-4" />
        <h2 className="text-sm font-semibold">Paso 0 · Conexión a MongoDB</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        El servidor no alcanza la base ({status.mongo.error ?? "sin detalle"}). Configura el URI, pruébalo y
        aplica con un reinicio guiado.
      </p>
      <div className="flex flex-col gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="setup-uri" className="font-mono text-xs">
            MONGODB_URI
          </Label>
          <Input
            id="setup-uri"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="mongodb://localhost:27017/?directConnection=true"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="setup-db" className="font-mono text-xs">
            MONGODB_DB
          </Label>
          <Input id="setup-db" value={db} onChange={(e) => setDb(e.target.value)} placeholder="aitl" />
        </div>
      </div>
      <Separator className="my-4" />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => void test()} disabled={!uri.trim() || busy !== null}>
          {busy === "probe" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}{" "}
          Probar conexión
        </Button>
        <Button onClick={() => void save()} disabled={!uri.trim() || busy !== null || probe?.ok !== true}>
          Guardar
        </Button>
        {savedKeys && (
          <Button onClick={() => void restart()} disabled={busy !== null}>
            {busy === "restart" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}{" "}
            Reiniciar y continuar
          </Button>
        )}
      </div>
      {probe && (
        <p className={`mt-3 text-xs ${probe.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {probe.ok ? "✓ conexión válida" : `✗ ${probe.error ?? "no responde"}`}
        </p>
      )}
      {savedKeys && (
        <p className="mt-1 text-xs text-muted-foreground">
          Guardado ({savedKeys.join(", ")}). El reinicio aplica la conexión; si el proceso no respawnea
          (arranca sin <code>--watch-restart</code>), relanza <code>aitl ui</code> a mano y recarga.
        </p>
      )}
    </Card>
  );
}

/* ── Paso 1: usuario Root ──────────────────────────────────────────────────── */

function RootStep({ onError, onCreated }: { onError: (e: unknown) => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password !== confirm) return onError("Las contraseñas no coinciden.");
    setBusy(true);
    try {
      await api.setupRoot(username.trim(), email.trim(), password);
      onError(null);
      onCreated();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <User className="h-4 w-4" />
        <h2 className="text-sm font-semibold">Paso 1 · Usuario Root</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        La primera cuenta de esta base de datos recibe el rol <b>root</b> y queda logueada para terminar la
        configuración. Este paso se cierra solo en cuanto exista un usuario real.
      </p>
      <div className="flex flex-col gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="root-user">usuario</Label>
          <Input id="root-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="root-email">email</Label>
          <Input id="root-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="root-pass">contraseña (≥ 12 caracteres)</Label>
          <Input id="root-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="root-pass2">confirmar contraseña</Label>
          <Input id="root-pass2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
      </div>
      <Separator className="my-4" />
      <Button
        onClick={() => void submit()}
        disabled={busy || !username.trim() || !email.trim() || password.length < 12 || !confirm}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Crear Root y
        continuar
      </Button>
    </Card>
  );
}

/* ── Paso 2: proveedor de modelo (opcional) ────────────────────────────────── */

function ProvidersStep({ onError, onNext }: { onError: (e: unknown) => void; onNext: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const updates: Record<string, string> = {};
    if (apiKey.trim()) updates.AITL_API_KEY = apiKey.trim();
    if (model.trim()) updates.MODEL_PRIMARY = model.trim();
    if (!Object.keys(updates).length) return onNext();
    setBusy(true);
    try {
      await api.updateConfig(updates);
      onError(null);
      onNext();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <ArrowRight className="h-4 w-4" />
        <h2 className="text-sm font-semibold">Paso 2 · Proveedor de modelo (opcional)</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Puedes dejarlo para después — la pestaña Config tiene el catálogo completo (LM Studio, OpenRouter,
        Anthropic, embeddings…).
      </p>
      <div className="flex flex-col gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="prov-key" className="font-mono text-xs">
            AITL_API_KEY
          </Label>
          <Input
            id="prov-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-… o sk-or-… (clasificada por prefijo)"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="prov-model" className="font-mono text-xs">
            MODEL_PRIMARY
          </Label>
          <Input
            id="prov-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="anthropic | openrouter | lmstudio | openai-compat | auto"
          />
        </div>
      </div>
      <Separator className="my-4" />
      <div className="flex items-center gap-2">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Guardar y continuar
        </Button>
        <Button variant="outline" onClick={onNext} disabled={busy}>
          Omitir
        </Button>
      </div>
    </Card>
  );
}

/* ── Paso 3: resumen + init-db ─────────────────────────────────────────────── */

function SummaryStep({ onError, onDone }: { onError: (e: unknown) => void; onDone: () => void }) {
  const [report, setReport] = useState<DbInitReport | null>(null);
  const [busy, setBusy] = useState(false);

  const runInit = async () => {
    setBusy(true);
    try {
      setReport(await api.initDb());
      onError(null);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-2">
        <Check className="h-4 w-4" />
        <h2 className="text-sm font-semibold">Paso 3 · Resumen</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Inicializa colecciones e índices (idempotente; el índice vectorial es best-effort en mongod sin Atlas
        Search) y entra a la app.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => void runInit()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />} Inicializar BD
        </Button>
        <Button onClick={onDone}>
          <ArrowRight className="h-4 w-4" /> Entrar a la app
        </Button>
      </div>
      {report && (
        <div className="mt-4 text-xs text-muted-foreground">
          <p>
            {report.collections.length} colecciones ·{" "}
            <Badge variant={report.vector.ok ? "default" : "secondary"} className="h-4 px-1 text-[10px]">
              vector {report.vector.ok ? "ok" : "fallback texto/recencia"}
            </Badge>
          </p>
          {!report.vector.ok && report.vector.error && <p className="mt-1">{report.vector.error}</p>}
        </div>
      )}
    </Card>
  );
}
