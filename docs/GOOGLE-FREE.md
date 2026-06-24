# Google free-tier provider

`AITL-Harness-JS` includes a Google free-tier profile through the existing Gemini
provider:

```powershell
aitl config set GEMINI_API_KEY <your-ai-studio-key>
aitl run "haz una tarea pequena" --project demo --model google-free
```

Aliases:

- `google-free`
- `gemini-free`

By default these aliases use:

```text
GEMINI_FREE_MODEL=gemini-3.5-flash
```

Override it if Google changes the free-tier model you want:

```powershell
aitl config set GEMINI_FREE_MODEL gemini-3.1-flash-lite
```

Notes:

- This is hosted Gemini API, not a local model.
- Free tier still requires a Google AI Studio API key.
- Google's free tier has rate limits and may use submitted content to improve their products.
- `--model gemini` stays configurable through `GEMINI_MODEL`; `--model google-free`
  always uses `GEMINI_FREE_MODEL`.
