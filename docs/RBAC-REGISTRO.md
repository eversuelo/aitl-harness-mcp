# RBAC and user registration

## Goal

AITL is meant to act as a secure gateway between users/agents and MongoDB. No web client,
remote agent or non-root user should ever know or use `MONGODB_URI` directly.

The MongoDB connection string lives only on the host where AITL runs:

```text
AITL Web / MCP client / host agent
  -> AITL Server
    -> MongoDB Atlas
```

## Principles

- Only the `root` user can register new users.
- Initial registration runs during `check-db` (or an equivalent bootstrap), never from a
  public screen.
- Regular users do not manage memory, decisions, agents, skills, indexes or global config.
- Regular users may only delete their own prompts.
- Privileged operations are performed by `aitl web` and `aitl server` through an
  authenticated/authorized host agent.
- Every sensitive event must record the actor, role, source, action, resource and result.

## Roles

| Role | Purpose |
|---|---|
| `root` | System owner. Can register users, rotate credentials, initialize the DB and manage RBAC. |
| `admin` | Operates AITL Web/Server, but cannot create root users or rotate base secrets. |
| `user` | Uses the UI and their own prompts. Can only delete their own prompts. |
| `agent` | Service identity for AITL Server / host agent. Runs authorized internal operations. |
| `auditor` | Read-only access to logs and events, with no mutations. |

## Initial registration

The bootstrap reads these variables:

```env
AITL_BOOTSTRAP_USERNAME=
AITL_BOOTSTRAP_EMAIL=
AITL_BOOTSTRAP_PASSWORD=
AITL_BOOTSTRAP_ROLE=root
```

Rules:

1. If no user exists in `users`, `check-db` may create the first user only if
   `AITL_BOOTSTRAP_ROLE=root`.
2. If at least one user already exists, `check-db` does not register more users.
3. If a `root` already exists, any later registration requires an authenticated `root`
   session.
4. `username`, `email` and `password` are required.
5. The password is never stored in plain text; it is stored hashed with a salt.
6. `username` and `email` are unique.

## `check-db` flow

`aitl check-db` validates, in this order:

1. Connection to MongoDB.
2. Existence of the `users` collection.
3. Unique indexes:
   - `users.username`
   - `users.email`
4. Existence of a `root` user.
5. If there are no users and a complete bootstrap is present, create the `root` user.
6. If root is missing, return an actionable warning.

Expected output:

```text
MongoDB ping OK via primary: <redacted-uri> (db=aitl)
Users collection OK
Root user: exists
RBAC status: ready
```

If root does not exist:

```text
RBAC status: missing-root
Set AITL_BOOTSTRAP_USERNAME, AITL_BOOTSTRAP_EMAIL, AITL_BOOTSTRAP_PASSWORD,
AITL_BOOTSTRAP_ROLE=root and run aitl check-db again.
```

## Permissions

| Resource | Action | `root` | `admin` | `user` | `agent` | `auditor` |
|---|---:|---:|---:|---:|---:|---:|
| users | create | yes | no | no | no | no |
| users | read | yes | yes | own | no | yes |
| users | change role | yes | no | no | no | no |
| users | disable | yes | no | no | no | no |
| prompts | create | yes | yes | own | yes | no |
| prompts | read | yes | yes | own | yes | yes |
| prompts | delete | yes | yes | own | yes | no |
| memory | create/edit/delete | yes | via AITL Server | no | yes | no |
| decisions | create/edit/delete | yes | via AITL Server | no | yes | no |
| agents/skills | create/edit/delete | yes | via AITL Server | no | yes | no |
| config/secrets | read/write | yes | via AITL Server | no | no | no |
| server_admin (restart/init-db/test-connection) | execute | yes | via AITL Server | no | no | no |
| indexes/init-db | run | yes | no | no | no | no |

> `config_secrets` gained admin "via AITL Server" (delegated) in ADR-0050 so the
> first-registered-user→admin flow can configure the harness from the web UI;
> `server_admin` (ADR-0061: guided restart, explicit init-db, connection probe)
> follows the same trust model. Setup-mode endpoints (`/api/setup/*`) are
> unauthenticated by design but restricted to loopback callers and hard-close as
> soon as a real user exists.

## Policy for regular users

A `user` can:

- log in;
- view their prompts;
- create their own prompts;
- delete their own prompts;
- request actions from the host agent via AITL Web.

A `user` cannot:

- write durable memory directly;
- record decisions directly;
- create agents or skills;
- run `init-db`;
- run user registration;
- read or export secrets;
- delete other users' prompts.

## Policy for AITL Web and AITL Server

AITL Web must not run privileged mutations directly as the end user. It must send requests
to AITL Server with an authenticated actor.

AITL Server decides whether to:

- respond directly;
- reject on RBAC grounds;
- delegate to a host agent with the `agent` identity;
- record a decision or memory as the result of an authorized action.

The host agent must operate with a service identity, for example:

```json
{
  "actor": {
    "type": "agent",
    "id": "agent:aitl-server",
    "role": "agent"
  }
}
```

## Minimal user model

```ts
type User = {
  username: string;
  email: string;
  role: "root" | "admin" | "user" | "agent" | "auditor";
  password_hash: string;
  password_salt: string;
  password_algo: string;
  disabled?: boolean;
  created_at: Date;
  updated_at: Date;
};
```

## Minimal audit model

```ts
type AuditEvent = {
  actor_id: string;
  actor_role: string;
  source: "web" | "server" | "mcp" | "cli" | "host-agent";
  action: string;
  resource: string;
  resource_owner?: string;
  ok: boolean;
  reason?: string;
  ts: Date;
};
```

## Suggested endpoints

| Endpoint | Minimum role | Description |
|---|---|---|
| `POST /api/auth/login` | public | Log in. |
| `POST /api/auth/logout` | authenticated | Log out. |
| `GET /api/auth/me` | authenticated | Return the current actor. |
| `POST /api/users` | `root` | Register a user. |
| `GET /api/users` | `root`/`admin` | List users without hashes. |
| `PATCH /api/users/:username/role` | `root` | Change a role. |
| `DELETE /api/prompts/:id` | owner/`admin`/`root` | Delete a prompt if owned or privileged. |

## Implementation status

| # | Task | Status | Where |
|---|---|---|---|
| 1 | Bootstrap defaults to `root` | done | `config.ts` (`bootstrapRole=root`), `auth/users.ts` (`bootstrapBaseUser` creates only the first user and requires the root role). |
| 2 | `check-db` validates users, indexes and root | done | `auth/checkdb.ts` (`checkRbac`), `aitl check-db` in `cli.ts`. |
| 3 | `owner_user` / `actor_id` on prompts | done | `prompts/store.ts` (`getById`/`deleteById`). |
| 4 | RBAC in the web API before every mutation | done | `server/api.ts` (`resolveActor` + `guard`); memory, prompts and users. |
| 5 | RBAC on MCP HTTP with a token mapped to an actor | done | `mcpserver/server.ts` (`mcpActor` + `guardTool` in `runLogged`, the `TOOL_RBAC` map). |
| 6 | Audit log of accepted and rejected actions | done | `auth/audit.ts` (`recordAudit`, the `audit` collection); used in web, MCP and CLI. |
| 7 | The web client never receives `MONGODB_URI`, tokens or hashes | done | `config/store.ts` masks secrets; `/api/config` requires the root role; `PUBLIC_USER_PROJECTION` excludes hashes. |
| 8 | Permission tests | done | `auth/rbac.test.ts`, `auth/users.test.ts` (`npm test`). |

> Note on the data layer: user documents are now defined by the Mongoose model in
> `src/models/user.model.ts` (ADR-0036), which is the single source of shape and types.
> The unique `username`/`email` indexes remain in `src/db/indexes.ts` (created by
> `aitl init-db`), not in the model, to keep index management in one place.

### Matrix as code

The **Permissions** table lives in `src/auth/rbac.ts` (`MATRIX` + `can()`), the single
source consulted by the web API, the MCP server and the CLI. Any policy change is made
there and is covered by `rbac.test.ts`.

### Actor identities per gateway

- **CLI**: the host operator acts as `root` (`cli:local`).
- **Web API**: a bearer token maps to an actor via `AITL_WEB_TOKENS`; without a valid token
  the caller is an anonymous `user` (least privilege), so privileged routes return 403.
- **MCP**: a service `agent` identity by default (`AITL_MCP_ACTOR_ID`/`_ROLE`); durable
  write tools are authorized as a server delegation.

### Pending (out of scope of this change)

- Session/cookie login (`POST /api/auth/login`, `/logout`): today web identity is resolved
  by bearer token; the full password session flow is missing.
- Propagate `owner_user` when prompts are created from web/MCP to enable owner-scoped
  deletion (the schema and the delete guard already support it).
